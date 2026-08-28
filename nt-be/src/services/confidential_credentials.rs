//! Encrypted storage for the 1Click confidential-intents JWTs.
//!
//! Access + refresh tokens are stored together as one AES-256-GCM envelope in
//! `monitored_accounts.{confidential,bulk_payment}_credentials_enc`, encrypted
//! with a key that lives only in the `CONFIDENTIAL_TOKEN_KEYRING_JSON` Render
//! secret (never in Postgres). The ciphertext is bound to the treasury and
//! credential scope via AAD, so a row copied to another account or scope will
//! not decrypt.
//!
//! Rollout compatibility: while the legacy plaintext token columns still
//! exist, writes keep them in sync with the envelope (so a rollback to the
//! pre-encryption release keeps every treasury working), reads fall back to
//! them when no envelope is stored, and a boot-time backfill encrypts
//! existing plaintext rows. The plaintext columns — and all this sync
//! machinery — disappear when the drop release removes them. When no keyring
//! is configured the store behaves exactly like the legacy plaintext columns
//! did.
//!
//! Key rotation safety: the singleton `confidential_credential_key_state`
//! row is a monotonic generation fence. Every pod registers its keyring
//! there at boot ([`ConfidentialCredentialStore::ensure_key_state`]), every
//! encrypted write takes a shared lock on the row and refuses to proceed
//! under a stale generation, and promotion to a new generation takes an
//! exclusive lock — draining in-flight writes — so a pod holding an old
//! keyring can never seal an envelope under a decommission-pending key.
//! A rotation counts as done only when a post-reconcile verification sweep
//! persists `rotation_status = 'complete'`; logs never authorize removing
//! a key from the ring.
//!
//! Ownership invariant: one keyring per database schema. Everything here —
//! reconcile's whole-table sweep, the key-state singleton — assumes every
//! row in `monitored_accounts` belongs to this keyring. The fingerprint
//! check makes a second independent keyring fail at boot against the same
//! schema. A shared-PG multi-tenant deployment must add owner scoping first.
//!
//! Every read/write of the token columns must go through
//! [`ConfidentialCredentialStore`] — handlers must not query them directly.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, Utc};
use secrecy::{ExposeSecret, SecretBox};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};

pub const KEYRING_ENV_VAR: &str = "CONFIDENTIAL_TOKEN_KEYRING_JSON";

const ENVELOPE_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CredentialScope {
    Dao,
    BulkPayment,
}

struct ScopeColumns {
    enc: &'static str,
    access: &'static str,
    refresh: &'static str,
    expires: &'static str,
}

impl CredentialScope {
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialScope::Dao => "dao",
            CredentialScope::BulkPayment => "bulk_payment",
        }
    }

    fn columns(self) -> ScopeColumns {
        match self {
            CredentialScope::Dao => ScopeColumns {
                enc: "confidential_credentials_enc",
                access: "confidential_access_token",
                refresh: "confidential_refresh_token",
                expires: "confidential_token_expires_at",
            },
            CredentialScope::BulkPayment => ScopeColumns {
                enc: "bulk_payment_credentials_enc",
                access: "bulk_payment_access_token",
                refresh: "bulk_payment_refresh_token",
                expires: "bulk_payment_token_expires_at",
            },
        }
    }
}

/// The decrypted credential pair. Deliberately no `Debug` derive — the
/// redacted impl below keeps tokens out of logs and error chains.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenBundle {
    pub access_token: String,
    pub refresh_token: String,
}

impl fmt::Debug for TokenBundle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TokenBundle { access_token: [REDACTED], refresh_token: [REDACTED] }")
    }
}

#[derive(Debug)]
pub enum CredentialError {
    Db(sqlx::Error),
    /// An envelope exists but no keyring is configured — fail closed.
    KeyringMissing,
    UnknownKeyId(String),
    MalformedEnvelope,
    DecryptFailed,
    EncryptFailed,
    /// This pod's keyring generation is behind the persisted key state — a
    /// newer keyring has been promoted. The write was refused; retry lands
    /// on an up-to-date pod (transient during a rotation rollout).
    StaleKeyGeneration {
        configured: i64,
        persisted: i64,
    },
    /// The persisted key state disagrees with this keyring at the same
    /// generation (different key id or fingerprint) — either two independent
    /// keyrings claim one schema or a key id was reused with new bytes.
    KeyStateConflict(String),
    /// A row changed under a maintenance write into a state the fence says
    /// is impossible (e.g. a non-active-key envelope appeared mid-rotation).
    ConcurrentModification,
}

impl CredentialError {
    /// Transient fence rejections a caller should surface as retryable
    /// (HTTP 503) rather than as a server error.
    pub fn is_retryable(&self) -> bool {
        matches!(self, CredentialError::StaleKeyGeneration { .. })
    }
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CredentialError::Db(e) => write!(f, "credential storage query failed: {}", e),
            CredentialError::KeyringMissing => write!(
                f,
                "encrypted credentials present but {} is not configured",
                KEYRING_ENV_VAR
            ),
            CredentialError::UnknownKeyId(id) => {
                write!(f, "credential envelope uses unknown key id '{}'", id)
            }
            CredentialError::MalformedEnvelope => write!(f, "credential envelope is malformed"),
            CredentialError::DecryptFailed => {
                write!(f, "credential envelope failed authenticated decryption")
            }
            CredentialError::EncryptFailed => write!(f, "credential encryption failed"),
            CredentialError::StaleKeyGeneration {
                configured,
                persisted,
            } => write!(
                f,
                "keyring generation {} is behind persisted key state generation {}; encrypted writes refused on this pod",
                configured, persisted
            ),
            CredentialError::KeyStateConflict(reason) => {
                write!(f, "keyring conflicts with persisted key state: {}", reason)
            }
            CredentialError::ConcurrentModification => {
                write!(
                    f,
                    "credential row changed concurrently in an unexpected way"
                )
            }
        }
    }
}

impl std::error::Error for CredentialError {}

impl From<sqlx::Error> for CredentialError {
    fn from(e: sqlx::Error) -> Self {
        CredentialError::Db(e)
    }
}

/// AES-256-GCM keyring parsed from `CONFIDENTIAL_TOKEN_KEYRING_JSON`:
/// `{"generation": 1, "active": "k1", "keys": {"k1": "<base64 32-byte key>"}}`.
/// Non-active keys stay decryptable to support incident rotation.
///
/// `generation` is the monotonic rotation fence persisted in
/// `confidential_credential_key_state`: increment it only when changing the
/// active key. An omitted generation defaults to 1 so pre-fence configs keep
/// booting.
pub struct TokenKeyring {
    generation: i64,
    active: String,
    /// Hex SHA-256 of the active key bytes — safe to persist and compare;
    /// never reveals key material.
    active_fingerprint: String,
    keys: HashMap<String, SecretBox<[u8; 32]>>,
}

impl fmt::Debug for TokenKeyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "TokenKeyring {{ active: {:?}, keys: [REDACTED; {}] }}",
            self.active,
            self.keys.len()
        )
    }
}

#[derive(Deserialize)]
struct KeyringConfig {
    #[serde(default = "default_generation")]
    generation: i64,
    active: String,
    keys: HashMap<String, String>,
}

fn default_generation() -> i64 {
    1
}

impl TokenKeyring {
    /// Loads the keyring from the environment. Absent/empty → `Ok(None)`
    /// (legacy plaintext mode); present but invalid → `Err`, so a
    /// misconfigured deploy fails at boot with a clean error instead of
    /// silently storing plaintext. The error names the env var and never
    /// echoes key material.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Some(raw) = std::env::var(KEYRING_ENV_VAR)
            .ok()
            .filter(|s| !s.trim().is_empty())
        else {
            return Ok(None);
        };
        Self::parse(&raw)
            .map(Some)
            .map_err(|e| format!("invalid {}: {}", KEYRING_ENV_VAR, e))
    }

    /// Error messages never echo key material or the raw JSON.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let config: KeyringConfig =
            serde_json::from_str(raw).map_err(|_| "not valid keyring JSON".to_string())?;
        if config.generation < 1 {
            return Err(format!(
                "generation {} must be a positive integer",
                config.generation
            ));
        }
        if config.keys.is_empty() {
            return Err("keyring has no keys".to_string());
        }
        if !config.keys.contains_key(&config.active) {
            return Err(format!("active key id '{}' not in keys", config.active));
        }
        let mut keys = HashMap::new();
        let mut active_fingerprint = String::new();
        for (id, encoded) in config.keys {
            if id.is_empty() || id.len() > 255 {
                return Err(format!("key id '{}' must be 1-255 bytes", id));
            }
            let decoded = BASE64
                .decode(encoded.trim())
                .map_err(|_| format!("key '{}' is not valid base64", id))?;
            let bytes: [u8; 32] = decoded
                .try_into()
                .map_err(|_| format!("key '{}' must decode to exactly 32 bytes", id))?;
            if id == config.active {
                active_fingerprint = hex::encode(Sha256::digest(bytes));
            }
            keys.insert(id, SecretBox::new(Box::new(bytes)));
        }
        Ok(Self {
            generation: config.generation,
            active: config.active,
            active_fingerprint,
            keys,
        })
    }

    pub fn active_key_id(&self) -> &str {
        &self.active
    }

    pub fn generation(&self) -> i64 {
        self.generation
    }

    pub fn active_key_fingerprint(&self) -> &str {
        &self.active_fingerprint
    }

    /// Hex SHA-256 of the named key's bytes; `None` when the id is not in
    /// the ring. Like the active fingerprint, safe to compare and persist.
    fn fingerprint_of(&self, key_id: &str) -> Option<String> {
        self.keys
            .get(key_id)
            .map(|key| hex::encode(Sha256::digest(*key.expose_secret())))
    }

    /// The key ID recorded in an envelope's header, without decrypting.
    pub fn envelope_key_id(envelope: &[u8]) -> Result<&str, CredentialError> {
        Self::parse_envelope(envelope).map(|(key_id, _, _)| key_id)
    }

    /// Splits an envelope into `(key_id, nonce, ciphertext)`.
    fn parse_envelope(envelope: &[u8]) -> Result<(&str, [u8; NONCE_LEN], &[u8]), CredentialError> {
        let (version, rest) = envelope
            .split_first()
            .ok_or(CredentialError::MalformedEnvelope)?;
        if *version != ENVELOPE_VERSION {
            return Err(CredentialError::MalformedEnvelope);
        }
        let (key_id_len, rest) = rest
            .split_first()
            .ok_or(CredentialError::MalformedEnvelope)?;
        let key_id_len = *key_id_len as usize;
        if rest.len() < key_id_len + NONCE_LEN {
            return Err(CredentialError::MalformedEnvelope);
        }
        let key_id = std::str::from_utf8(&rest[..key_id_len])
            .map_err(|_| CredentialError::MalformedEnvelope)?;
        let nonce: [u8; NONCE_LEN] = rest[key_id_len..key_id_len + NONCE_LEN]
            .try_into()
            .map_err(|_| CredentialError::MalformedEnvelope)?;
        Ok((key_id, nonce, &rest[key_id_len + NONCE_LEN..]))
    }

    fn aad(account_id: &str, scope: CredentialScope) -> String {
        format!(
            "nt-confidential-credentials|v{}|{}|{}",
            ENVELOPE_VERSION,
            account_id,
            scope.as_str()
        )
    }

    fn cipher_for(&self, key_id: &str) -> Result<Aes256Gcm, CredentialError> {
        let key = self
            .keys
            .get(key_id)
            .ok_or_else(|| CredentialError::UnknownKeyId(key_id.to_string()))?;
        let key: Key<Aes256Gcm> = (*key.expose_secret()).into();
        Ok(Aes256Gcm::new(&key))
    }

    /// Envelope layout: `[version u8][key_id_len u8][key_id][nonce 12B][ciphertext]`.
    pub fn encrypt(
        &self,
        account_id: &str,
        scope: CredentialScope,
        bundle: &TokenBundle,
    ) -> Result<Vec<u8>, CredentialError> {
        let cipher = self.cipher_for(&self.active)?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let msg = serde_json::to_vec(bundle).map_err(|_| CredentialError::EncryptFailed)?;
        let aad = Self::aad(account_id, scope);
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: &msg,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| CredentialError::EncryptFailed)?;

        let key_id = self.active.as_bytes();
        let mut envelope = Vec::with_capacity(2 + key_id.len() + NONCE_LEN + ciphertext.len());
        envelope.push(ENVELOPE_VERSION);
        envelope.push(key_id.len() as u8);
        envelope.extend_from_slice(key_id);
        envelope.extend_from_slice(&nonce);
        envelope.extend_from_slice(&ciphertext);
        Ok(envelope)
    }

    pub fn decrypt(
        &self,
        account_id: &str,
        scope: CredentialScope,
        envelope: &[u8],
    ) -> Result<TokenBundle, CredentialError> {
        let (key_id, nonce, ciphertext) = Self::parse_envelope(envelope)?;
        let cipher = self.cipher_for(key_id)?;
        let aad = Self::aad(account_id, scope);
        let plaintext = cipher
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| CredentialError::DecryptFailed)?;
        serde_json::from_slice(&plaintext).map_err(|_| CredentialError::DecryptFailed)
    }
}

/// Credential columns loaded for one treasury + scope. Partial rows (only one
/// token present) can only come from the legacy plaintext columns; envelopes
/// always hold a complete pair.
pub struct StoredCredentials {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    /// True when the tokens were decrypted from an envelope (vs the legacy
    /// plaintext fallback).
    pub from_envelope: bool,
    /// The legacy plaintext refresh token, carried alongside an envelope so
    /// the refresh path can heal a stale envelope after a deploy overlap
    /// (the previous release wrote a newer pair to plaintext only). Always
    /// None when the tokens themselves came from plaintext, and gone for
    /// good once the plaintext columns are dropped.
    pub legacy_refresh_token: Option<String>,
}

pub struct BackfillReport {
    pub encrypted: usize,
    pub already_encrypted: usize,
    /// Envelopes re-encrypted from a non-active key to the active key
    /// (incident key rotation).
    pub rotated: usize,
    /// Rows that could not be processed (crypto or DB failure); details are
    /// in per-row error logs. Non-zero means old keys must NOT be removed
    /// from the keyring yet.
    pub failed: usize,
    /// `(account_id, scope)` rows missing one half of the pair — unusable by
    /// the refresh flow; those treasuries must re-authenticate.
    pub partial: Vec<(String, CredentialScope)>,
    /// Rows still lacking a decryptable active-key envelope at the
    /// post-sweep verification pass. This — not the per-row write counters,
    /// which can be raced — is what decides rotation completeness.
    pub stale_after_sweep: usize,
    /// Whether this run persisted `rotation_status = 'complete'` in
    /// `confidential_credential_key_state`. Old keys may be removed from the
    /// keyring only while the persisted state says complete.
    pub rotation_complete: bool,
}

impl BackfillReport {
    /// A clean run: every credential row is encrypted under the active key,
    /// verified by re-reading after the sweep.
    pub fn is_clean(&self) -> bool {
        self.failed == 0 && self.partial.is_empty() && self.stale_after_sweep == 0
    }
}

/// Row shape for [`ConfidentialCredentialStore::load`]:
/// `(envelope, plaintext access, plaintext refresh, expiry)`.
type LoadRow = (
    Option<Vec<u8>>,
    Option<String>,
    Option<String>,
    Option<DateTime<Utc>>,
);

/// Row shape for [`ConfidentialCredentialStore::reconcile`]:
/// `(account_id, plaintext access, plaintext refresh, envelope)`.
type ReconcileRow = (String, Option<String>, Option<String>, Option<Vec<u8>>);

/// Persisted key-state fence: `(generation, active key id, fingerprint)`.
type KeyStateRow = (i64, String, String);

/// The credential columns a repair write was derived from. A CAS write
/// proceeds only while every part still matches — the envelope alone is not
/// enough, because legacy plaintext-only writes change the token columns
/// without touching the envelope.
struct RowSnapshot<'a> {
    envelope: &'a [u8],
    plaintext_access: &'a str,
    plaintext_refresh: &'a str,
}

const KEY_STATE_SELECT: &str = "SELECT generation, active_key_id, active_key_fingerprint FROM confidential_credential_key_state";

const KEY_STATE_INSERT: &str = "INSERT INTO confidential_credential_key_state \
     (singleton, generation, active_key_id, active_key_fingerprint, rotation_status) \
     VALUES (TRUE, $1, $2, $3, 'pending') ON CONFLICT (singleton) DO NOTHING";

/// The single gateway to confidential JWT storage. `keyring: None` preserves
/// the legacy plaintext behavior (used by tests and pre-rollout environments).
#[derive(Clone)]
pub struct ConfidentialCredentialStore {
    pool: PgPool,
    keyring: Option<Arc<TokenKeyring>>,
}

impl ConfidentialCredentialStore {
    pub fn new(pool: PgPool, keyring: Option<Arc<TokenKeyring>>) -> Self {
        Self { pool, keyring }
    }

    /// Registers this pod's keyring against the persisted key-state fence.
    /// Called at boot; an `Err` must fail startup — a pod whose keyring the
    /// fence rejects can never perform an encrypted write anyway.
    ///
    /// First keyring ever → bootstraps the row (`rotation_status = pending`
    /// until the first verified reconcile). Same generation → the key id and
    /// fingerprint must match, so a second independent keyring cannot claim
    /// this schema and a key id cannot be reused with different bytes. Newer
    /// generation → promotion: the exclusive lock drains in-flight fenced
    /// writes before the new generation becomes the floor. No-op without a
    /// keyring.
    pub async fn ensure_key_state(&self) -> Result<(), CredentialError> {
        let Some(keyring) = self.keyring.as_deref() else {
            return Ok(());
        };
        let mut tx = self.pool.begin().await?;
        sqlx::query(KEY_STATE_INSERT)
            .bind(keyring.generation())
            .bind(keyring.active_key_id())
            .bind(keyring.active_key_fingerprint())
            .execute(&mut *tx)
            .await?;
        let (generation, key_id, fingerprint): KeyStateRow =
            sqlx::query_as(&format!("{} FOR UPDATE", KEY_STATE_SELECT))
                .fetch_one(&mut *tx)
                .await?;

        match keyring.generation().cmp(&generation) {
            Ordering::Less => Err(CredentialError::StaleKeyGeneration {
                configured: keyring.generation(),
                persisted: generation,
            }),
            Ordering::Equal => {
                if key_id != keyring.active_key_id()
                    || fingerprint != keyring.active_key_fingerprint()
                {
                    return Err(CredentialError::KeyStateConflict(format!(
                        "generation {} is already registered with active key id '{}' and a different fingerprint",
                        generation, key_id
                    )));
                }
                tx.commit().await?;
                Ok(())
            }
            Ordering::Greater => {
                // A promotion must retain the previous active key unchanged:
                // without it the existing envelopes can't be decrypted for
                // rotation, and an old id reused with new bytes is worse —
                // envelope headers still name it, so those rows could never
                // be repaired automatically. Caught here, before this pod
                // serves or writes anything.
                match keyring.fingerprint_of(&key_id) {
                    None => {
                        return Err(CredentialError::KeyStateConflict(format!(
                            "promotion to generation {} must retain previous active key '{}' for decryption",
                            keyring.generation(),
                            key_id
                        )));
                    }
                    Some(fp) if fp != fingerprint => {
                        return Err(CredentialError::KeyStateConflict(format!(
                            "key id '{}' is reused with different bytes; envelopes under it would be unrepairable",
                            key_id
                        )));
                    }
                    Some(_) => {}
                }
                sqlx::query(
                    "UPDATE confidential_credential_key_state \
                     SET generation = $1, active_key_id = $2, active_key_fingerprint = $3, \
                         rotation_status = 'pending', promoted_at = NOW(), verified_at = NULL \
                     WHERE generation < $1",
                )
                .bind(keyring.generation())
                .bind(keyring.active_key_id())
                .bind(keyring.active_key_fingerprint())
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
                tracing::info!(
                    generation = keyring.generation(),
                    active_key_id = keyring.active_key_id(),
                    "promoted confidential keyring generation; rotation pending until verified"
                );
                Ok(())
            }
        }
    }

    /// Opens a transaction holding a shared lock on the key-state row after
    /// verifying this keyring is the persisted generation. Every write that
    /// produces ciphertext goes through this fence, so a pod holding an old
    /// keyring cannot seal an envelope after a newer generation is promoted
    /// (promotion's exclusive lock waits for these shared locks to release).
    async fn begin_fenced_write(
        &self,
        keyring: &TokenKeyring,
    ) -> Result<Transaction<'static, Postgres>, CredentialError> {
        // Two attempts: the second runs only after ensure_key_state promotes
        // this keyring's newer generation into the fence.
        for _ in 0..2 {
            let mut tx = self.pool.begin().await?;
            let select = format!("{} FOR SHARE", KEY_STATE_SELECT);
            let row: Option<KeyStateRow> = sqlx::query_as(&select).fetch_optional(&mut *tx).await?;
            let (generation, key_id, fingerprint) = match row {
                Some(row) => row,
                None => {
                    sqlx::query(KEY_STATE_INSERT)
                        .bind(keyring.generation())
                        .bind(keyring.active_key_id())
                        .bind(keyring.active_key_fingerprint())
                        .execute(&mut *tx)
                        .await?;
                    sqlx::query_as(&select).fetch_one(&mut *tx).await?
                }
            };
            match keyring.generation().cmp(&generation) {
                Ordering::Less => {
                    return Err(CredentialError::StaleKeyGeneration {
                        configured: keyring.generation(),
                        persisted: generation,
                    });
                }
                Ordering::Equal => {
                    if key_id != keyring.active_key_id()
                        || fingerprint != keyring.active_key_fingerprint()
                    {
                        return Err(CredentialError::KeyStateConflict(format!(
                            "generation {} is already registered with active key id '{}' and a different fingerprint",
                            generation, key_id
                        )));
                    }
                    return Ok(tx);
                }
                // This keyring is newer than the fence (ensure_key_state has
                // not run yet). Promote in a separate exclusive-lock
                // transaction — upgrading the shared lock in place could
                // deadlock with another writer doing the same — then retry.
                Ordering::Greater => {
                    drop(tx);
                    self.ensure_key_state().await?;
                }
            }
        }
        Err(CredentialError::KeyStateConflict(
            "key state kept changing during a fenced write".to_string(),
        ))
    }

    /// `None` means the account has no `monitored_accounts` row at all.
    pub async fn load(
        &self,
        account_id: &str,
        scope: CredentialScope,
    ) -> Result<Option<StoredCredentials>, CredentialError> {
        let c = scope.columns();
        let sql = format!(
            "SELECT {}, {}, {}, {} FROM monitored_accounts WHERE account_id = $1",
            c.enc, c.access, c.refresh, c.expires
        );
        let row: Option<LoadRow> = sqlx::query_as(&sql)
            .bind(account_id)
            .fetch_optional(&self.pool)
            .await?;

        let Some((envelope, access, refresh, expires_at)) = row else {
            return Ok(None);
        };

        if let Some(envelope) = envelope {
            let keyring = self
                .keyring
                .as_deref()
                .ok_or(CredentialError::KeyringMissing)?;
            let bundle = keyring.decrypt(account_id, scope, &envelope)?;

            // A divergent complete plaintext pair is always NEWER than the
            // envelope: this release writes both in one UPDATE, so only the
            // previous plaintext-only release can make them differ (a refresh
            // or re-auth landing on an old instance during a rolling deploy).
            // Serve the plaintext pair and re-encrypt it so the envelope
            // heals on first touch. Dies with the plaintext columns.
            if let (Some(pt_access), Some(pt_refresh)) = (&access, &refresh)
                && (*pt_access != bundle.access_token || *pt_refresh != bundle.refresh_token)
            {
                tracing::warn!(
                    account_id,
                    scope = scope.as_str(),
                    "plaintext credentials newer than envelope; healing envelope from plaintext"
                );
                let newer = TokenBundle {
                    access_token: pt_access.clone(),
                    refresh_token: pt_refresh.clone(),
                };
                // Healing is best-effort and derived from this read, so it
                // CAS-guards on the full snapshot it read — envelope AND
                // plaintext pair. Guarding the envelope alone would lose to
                // a legacy plaintext-only write landing between this read
                // and the heal: same envelope bytes, newer tokens.
                let snapshot = RowSnapshot {
                    envelope: &envelope,
                    plaintext_access: pt_access,
                    plaintext_refresh: pt_refresh,
                };
                match self
                    .write_encrypted_synced(
                        keyring,
                        account_id,
                        scope,
                        &newer,
                        expires_at,
                        Some(&snapshot),
                    )
                    .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        tracing::debug!(
                            account_id,
                            scope = scope.as_str(),
                            "concurrent write superseded envelope heal; skipping"
                        );
                    }
                    // Still serve the newer pair.
                    Err(e) => {
                        crate::error_event!(
                            crate::error_event::ErrorCode::ConfEnvelopeHealFailed,
                            account_id,
                            scope = scope.as_str(),
                            error = %e
                        );
                    }
                }
                return Ok(Some(StoredCredentials {
                    access_token: Some(newer.access_token),
                    refresh_token: Some(newer.refresh_token),
                    expires_at,
                    from_envelope: false,
                    legacy_refresh_token: None,
                }));
            }

            let mut expires_at = expires_at;
            if access.is_some() != refresh.is_some() {
                // A partial plaintext pair beside an envelope is a legacy
                // write artifact and is deliberately NOT healable: never
                // combine plaintext and envelope halves into a hybrid pair.
                // Serve the envelope pair — but with the expiry dropped: the
                // expiry column belongs to whatever legacy write left the
                // row partial, and a future value would vouch for the
                // envelope's access token without a 1Click check. No expiry
                // forces the refresh path to validate before serving; if the
                // envelope's refresh token turns out stale, the 1Click 401
                // fallback retries `legacy_refresh_token`
                // (see handlers/intents/confidential/mod.rs).
                tracing::warn!(
                    account_id,
                    scope = scope.as_str(),
                    has_plaintext_access = access.is_some(),
                    has_plaintext_refresh = refresh.is_some(),
                    "partial legacy plaintext alongside envelope; serving envelope pair with expiry dropped"
                );
                expires_at = None;
            }

            return Ok(Some(StoredCredentials {
                access_token: Some(bundle.access_token),
                refresh_token: Some(bundle.refresh_token),
                expires_at,
                from_envelope: true,
                legacy_refresh_token: refresh,
            }));
        }

        Ok(Some(StoredCredentials {
            access_token: access,
            refresh_token: refresh,
            expires_at,
            from_envelope: false,
            legacy_refresh_token: None,
        }))
    }

    /// Envelope write with the legacy plaintext columns kept in sync, so a
    /// rollback to the pre-encryption release keeps every treasury working
    /// until the plaintext columns are dropped. Runs behind the generation
    /// fence.
    ///
    /// `expected` makes the write a compare-and-swap for repair paths that
    /// re-encrypt data from an earlier read: `Ok(false)` means a concurrent
    /// write won and this write was skipped. Authoritative writes (fresh
    /// tokens from 1Click) pass `None` — they always win.
    async fn write_encrypted_synced(
        &self,
        keyring: &TokenKeyring,
        account_id: &str,
        scope: CredentialScope,
        bundle: &TokenBundle,
        expires_at: Option<DateTime<Utc>>,
        expected: Option<&RowSnapshot<'_>>,
    ) -> Result<bool, CredentialError> {
        let c = scope.columns();
        let envelope = keyring.encrypt(account_id, scope, bundle)?;
        let mut tx = self.begin_fenced_write(keyring).await?;
        let mut sql = format!(
            "UPDATE monitored_accounts SET {} = $1, {} = $2, {} = $3, {} = $4 WHERE account_id = $5",
            c.enc, c.expires, c.access, c.refresh
        );
        if expected.is_some() {
            // The plaintext columns are part of the guard: the racing writer
            // a heal must yield to is a legacy plaintext-only pod, whose
            // writes never touch the envelope.
            sql.push_str(&format!(
                " AND {} = $6 AND {} = $7 AND {} = $8",
                c.enc, c.access, c.refresh
            ));
        }
        let mut query = sqlx::query(&sql)
            .bind(envelope)
            .bind(expires_at)
            .bind(&bundle.access_token)
            .bind(&bundle.refresh_token)
            .bind(account_id);
        if let Some(snapshot) = expected {
            query = query
                .bind(snapshot.envelope)
                .bind(snapshot.plaintext_access)
                .bind(snapshot.plaintext_refresh);
        }
        let result = query.execute(&mut *tx).await?;
        tx.commit().await?;
        if result.rows_affected() == 0 {
            if expected.is_some() {
                return Ok(false);
            }
            return Err(CredentialError::Db(sqlx::Error::RowNotFound));
        }
        Ok(true)
    }

    /// Persist a freshly issued credential pair (initial auth / re-auth).
    /// Errors when the account has no `monitored_accounts` row — a write
    /// that updates nothing must not report success.
    pub async fn store_new(
        &self,
        account_id: &str,
        scope: CredentialScope,
        bundle: &TokenBundle,
        expires_at: DateTime<Utc>,
    ) -> Result<(), CredentialError> {
        match &self.keyring {
            Some(keyring) => self
                .write_encrypted_synced(keyring, account_id, scope, bundle, Some(expires_at), None)
                .await
                .map(|_| ()),
            None => {
                self.store_new_plaintext_fallback(account_id, scope, bundle, expires_at)
                    .await
            }
        }
    }

    /// Plaintext-only write, deliberately outside the generation fence.
    /// Legacy mode (no keyring) uses it for every `store_new`; with a
    /// keyring it is the last resort for background flows that cannot retry
    /// a fence rejection (vote relay: 1Click has already issued the pair,
    /// and this pod's stale keyring can never pass the fence). The write
    /// leaves the envelope untouched, producing exactly the
    /// plaintext-newer-than-envelope shape [`Self::load`] heals into an
    /// active-key envelope on the next touch from an up-to-date pod (a row
    /// with no envelope yet is encrypted by the next boot's reconcile
    /// instead). Interactive flows must NOT use this — they surface a
    /// retryable 503 instead. Dies with the plaintext columns.
    pub async fn store_new_plaintext_fallback(
        &self,
        account_id: &str,
        scope: CredentialScope,
        bundle: &TokenBundle,
        expires_at: DateTime<Utc>,
    ) -> Result<(), CredentialError> {
        let c = scope.columns();
        let sql = format!(
            "UPDATE monitored_accounts SET {} = $1, {} = $2, {} = $3 WHERE account_id = $4",
            c.access, c.refresh, c.expires
        );
        let result = sqlx::query(&sql)
            .bind(&bundle.access_token)
            .bind(&bundle.refresh_token)
            .bind(expires_at)
            .bind(account_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(CredentialError::Db(sqlx::Error::RowNotFound));
        }
        Ok(())
    }

    /// Persist a refreshed access token (refresh token carried over from the
    /// stored bundle). Same sync-to-plaintext behavior as [`store_new`]; the
    /// legacy-mode variant preserves the historical "update access + expiry
    /// only" shape.
    pub async fn store_refreshed(
        &self,
        account_id: &str,
        scope: CredentialScope,
        bundle: &TokenBundle,
        expires_at: DateTime<Utc>,
    ) -> Result<(), CredentialError> {
        let c = scope.columns();
        match &self.keyring {
            Some(keyring) => self
                .write_encrypted_synced(keyring, account_id, scope, bundle, Some(expires_at), None)
                .await
                .map(|_| ()),
            None => {
                let sql = format!(
                    "UPDATE monitored_accounts SET {} = $1, {} = $2 WHERE account_id = $3",
                    c.access, c.expires
                );
                let result = sqlx::query(&sql)
                    .bind(&bundle.access_token)
                    .bind(expires_at)
                    .bind(account_id)
                    .execute(&self.pool)
                    .await?;
                if result.rows_affected() == 0 {
                    return Err(CredentialError::Db(sqlx::Error::RowNotFound));
                }
                Ok(())
            }
        }
    }

    /// Whether any credentials (encrypted or legacy plaintext) are stored.
    /// Never pulls token material out of the database.
    pub async fn present(
        &self,
        account_id: &str,
        scope: CredentialScope,
    ) -> Result<bool, CredentialError> {
        let c = scope.columns();
        let sql = format!(
            "SELECT EXISTS (SELECT 1 FROM monitored_accounts WHERE account_id = $1 AND ({} IS NOT NULL OR {} IS NOT NULL))",
            c.enc, c.access
        );
        let exists: bool = sqlx::query_scalar(&sql)
            .bind(account_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(exists)
    }

    /// Like [`present`], but also requires the stored access token to be
    /// unexpired (a NULL expiry counts as valid, matching the legacy check).
    pub async fn valid_unexpired(
        &self,
        account_id: &str,
        scope: CredentialScope,
    ) -> Result<bool, CredentialError> {
        let c = scope.columns();
        let sql = format!(
            "SELECT EXISTS (SELECT 1 FROM monitored_accounts WHERE account_id = $1 AND ({} IS NOT NULL OR {} IS NOT NULL) AND ({} IS NULL OR {} > NOW()))",
            c.enc, c.access, c.expires, c.expires
        );
        let exists: bool = sqlx::query_scalar(&sql)
            .bind(account_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(exists)
    }

    /// One-shot, idempotent boot-time reconciliation of credential storage:
    /// encrypts every legacy plaintext pair with no envelope yet (verified by
    /// an in-memory decrypt-compare; plaintext stays in place for rollback
    /// until the columns are dropped), and re-encrypts envelopes still on a
    /// non-active key so an incident key rotation can complete and the old
    /// key can be removed. Row-level failures are counted and logged, never
    /// abort the sweep. No-op without a keyring.
    ///
    /// After the sweep, a fresh verification pass re-reads every row: only
    /// when it confirms a decryptable active-key envelope on every
    /// credential-bearing row does this persist `rotation_status =
    /// 'complete'` — the per-row write counters can be raced by concurrent
    /// writes and are never treated as proof. Assumes this keyring owns
    /// every row in the schema (see the module docs' ownership invariant).
    pub async fn reconcile(&self) -> Result<BackfillReport, CredentialError> {
        let mut report = BackfillReport {
            encrypted: 0,
            already_encrypted: 0,
            rotated: 0,
            failed: 0,
            partial: Vec::new(),
            stale_after_sweep: 0,
            rotation_complete: false,
        };
        let Some(keyring) = self.keyring.as_deref() else {
            return Ok(report);
        };
        // Registering the keyring first also rejects a stale-generation pod
        // before its sweep can rotate envelopes back to an old key.
        self.ensure_key_state().await?;

        for scope in [CredentialScope::Dao, CredentialScope::BulkPayment] {
            let c = scope.columns();
            let sql = format!(
                "SELECT account_id, {}, {}, {} FROM monitored_accounts WHERE {} IS NOT NULL OR {} IS NOT NULL OR {} IS NOT NULL",
                c.access, c.refresh, c.enc, c.access, c.refresh, c.enc
            );
            let rows: Vec<ReconcileRow> = sqlx::query_as(&sql).fetch_all(&self.pool).await?;

            for (account_id, access, refresh, envelope) in rows {
                let row_result = if let Some(envelope) = envelope {
                    self.rotate_envelope_if_stale(
                        keyring,
                        &account_id,
                        scope,
                        envelope,
                        &mut report,
                    )
                    .await
                } else if let (Some(access), Some(refresh)) = (access, refresh) {
                    self.encrypt_plaintext_row(
                        keyring,
                        &account_id,
                        scope,
                        access,
                        refresh,
                        &mut report,
                    )
                    .await
                } else {
                    tracing::warn!(
                        account_id,
                        scope = scope.as_str(),
                        "partial legacy credential pair cannot be encrypted; treasury must re-authenticate"
                    );
                    report.partial.push((account_id, scope));
                    continue;
                };
                if let Err(e) = row_result {
                    report.failed += 1;
                    crate::error_event!(
                        crate::error_event::ErrorCode::ConfCredentialReconcileFailed,
                        account_id,
                        scope = scope.as_str(),
                        error = %e
                    );
                }
            }
        }

        report.stale_after_sweep = self.count_unverified_rows(keyring).await?;
        if report.failed == 0 && report.stale_after_sweep == 0 {
            // The generation + fingerprint predicate keeps a racing
            // promotion from being marked complete by this run.
            let result = sqlx::query(
                "UPDATE confidential_credential_key_state \
                 SET rotation_status = 'complete', verified_at = NOW() \
                 WHERE generation = $1 AND active_key_fingerprint = $2",
            )
            .bind(keyring.generation())
            .bind(keyring.active_key_fingerprint())
            .execute(&self.pool)
            .await?;
            report.rotation_complete = result.rows_affected() > 0;
        } else {
            // A dirty sweep demotes a previously persisted completion: the
            // state must never say complete while a row lacks a verified
            // active-key envelope — an in-flight decommission that
            // re-checks sees pending and stops, which is exactly the safe
            // direction to fail in.
            let demoted = sqlx::query(
                "UPDATE confidential_credential_key_state \
                 SET rotation_status = 'pending', verified_at = NULL \
                 WHERE rotation_status = 'complete'",
            )
            .execute(&self.pool)
            .await?;
            if demoted.rows_affected() > 0 {
                tracing::warn!(
                    failed = report.failed,
                    stale_after_sweep = report.stale_after_sweep,
                    "demoted persisted rotation status to pending after dirty verification sweep"
                );
            }
        }
        Ok(report)
    }

    /// Verification pass for [`reconcile`]: the number of credential-bearing
    /// rows that do NOT hold a decryptable envelope under the active key —
    /// stale-key envelopes, undecryptable/malformed ones, and plaintext-only
    /// or partial rows alike. Zero is the only state in which a rotation may
    /// be persisted as complete.
    async fn count_unverified_rows(
        &self,
        keyring: &TokenKeyring,
    ) -> Result<usize, CredentialError> {
        let mut unverified = 0;
        for scope in [CredentialScope::Dao, CredentialScope::BulkPayment] {
            let c = scope.columns();
            let sql = format!(
                "SELECT account_id, {}, {}, {} FROM monitored_accounts WHERE {} IS NOT NULL OR {} IS NOT NULL OR {} IS NOT NULL",
                c.access, c.refresh, c.enc, c.access, c.refresh, c.enc
            );
            let rows: Vec<ReconcileRow> = sqlx::query_as(&sql).fetch_all(&self.pool).await?;
            for (account_id, _, _, envelope) in rows {
                let verified = match envelope {
                    Some(env) => {
                        TokenKeyring::envelope_key_id(&env)
                            .is_ok_and(|id| id == keyring.active_key_id())
                            && keyring.decrypt(&account_id, scope, &env).is_ok()
                    }
                    None => false,
                };
                if !verified {
                    unverified += 1;
                }
            }
        }
        Ok(unverified)
    }

    async fn rotate_envelope_if_stale(
        &self,
        keyring: &TokenKeyring,
        account_id: &str,
        scope: CredentialScope,
        envelope: Vec<u8>,
        report: &mut BackfillReport,
    ) -> Result<(), CredentialError> {
        if TokenKeyring::envelope_key_id(&envelope)? == keyring.active_key_id() {
            report.already_encrypted += 1;
            return Ok(());
        }
        let bundle = keyring.decrypt(account_id, scope, &envelope)?;
        let new_envelope = keyring.encrypt(account_id, scope, &bundle)?;
        let c = scope.columns();
        // Compare-and-swap on the old bytes: a concurrent refresh that
        // already rewrote the row under the active key wins. The fence
        // guarantees any such concurrent write used the active key.
        let sql = format!(
            "UPDATE monitored_accounts SET {} = $1 WHERE account_id = $2 AND {} = $3",
            c.enc, c.enc
        );
        let mut tx = self.begin_fenced_write(keyring).await?;
        let result = sqlx::query(&sql)
            .bind(new_envelope)
            .bind(account_id)
            .bind(&envelope)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        if result.rows_affected() > 0 {
            report.rotated += 1;
            return Ok(());
        }
        // CAS loss: never trust it blindly — re-read and verify the winner
        // actually left an active-key envelope in place.
        let sql = format!(
            "SELECT {} FROM monitored_accounts WHERE account_id = $1",
            c.enc
        );
        let (current,): (Option<Vec<u8>>,) = sqlx::query_as(&sql)
            .bind(account_id)
            .fetch_one(&self.pool)
            .await?;
        match current {
            Some(env) if TokenKeyring::envelope_key_id(&env)? == keyring.active_key_id() => {
                report.already_encrypted += 1;
                Ok(())
            }
            _ => Err(CredentialError::ConcurrentModification),
        }
    }

    async fn encrypt_plaintext_row(
        &self,
        keyring: &TokenKeyring,
        account_id: &str,
        scope: CredentialScope,
        access: String,
        refresh: String,
        report: &mut BackfillReport,
    ) -> Result<(), CredentialError> {
        let bundle = TokenBundle {
            access_token: access,
            refresh_token: refresh,
        };
        let envelope = keyring.encrypt(account_id, scope, &bundle)?;
        if keyring.decrypt(account_id, scope, &envelope)? != bundle {
            return Err(CredentialError::DecryptFailed);
        }
        let c = scope.columns();
        // CAS on both plaintext tokens: a concurrent legacy refresh that
        // changed the pair after this sweep read it must not be sealed stale.
        let sql = format!(
            "UPDATE monitored_accounts SET {} = $1 WHERE account_id = $2 AND {} IS NULL AND {} = $3 AND {} = $4",
            c.enc, c.enc, c.access, c.refresh
        );
        let mut tx = self.begin_fenced_write(keyring).await?;
        let result = sqlx::query(&sql)
            .bind(envelope)
            .bind(account_id)
            .bind(&bundle.access_token)
            .bind(&bundle.refresh_token)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        if result.rows_affected() > 0 {
            report.encrypted += 1;
            return Ok(());
        }
        // CAS loss: an envelope written concurrently under the active key is
        // fine; anything else (e.g. the plaintext pair changed and the row is
        // still unencrypted) is counted failed and swept up at the next boot.
        let sql = format!(
            "SELECT {} FROM monitored_accounts WHERE account_id = $1",
            c.enc
        );
        let (current,): (Option<Vec<u8>>,) = sqlx::query_as(&sql)
            .bind(account_id)
            .fetch_one(&self.pool)
            .await?;
        match current {
            Some(env) if TokenKeyring::envelope_key_id(&env)? == keyring.active_key_id() => {
                report.already_encrypted += 1;
                Ok(())
            }
            _ => Err(CredentialError::ConcurrentModification),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_keyring() -> TokenKeyring {
        TokenKeyring::parse(
            r#"{"active":"k1","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","k2":"//////////////////////////////////////////8="}}"#,
        )
        .expect("valid test keyring")
    }

    /// The post-rotation keyring: generation 2, active k2, k1 retained for
    /// decryption.
    fn rotated_keyring() -> TokenKeyring {
        TokenKeyring::parse(
            r#"{"generation":2,"active":"k2","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","k2":"//////////////////////////////////////////8="}}"#,
        )
        .expect("valid rotated keyring")
    }

    fn bundle() -> TokenBundle {
        TokenBundle {
            access_token: "access-token-fixture".to_string(),
            refresh_token: "refresh-token-fixture".to_string(),
        }
    }

    /// `(generation, active_key_id, fingerprint, rotation_status, verified_at)`.
    async fn key_state(pool: &PgPool) -> (i64, String, String, String, Option<DateTime<Utc>>) {
        sqlx::query_as(
            "SELECT generation, active_key_id, active_key_fingerprint, rotation_status, verified_at FROM confidential_credential_key_state",
        )
        .fetch_one(pool)
        .await
        .expect("key state row")
    }

    #[test]
    fn round_trips_both_scopes() {
        let keyring = test_keyring();
        for scope in [CredentialScope::Dao, CredentialScope::BulkPayment] {
            let envelope = keyring.encrypt("dao.near", scope, &bundle()).unwrap();
            let decrypted = keyring.decrypt("dao.near", scope, &envelope).unwrap();
            assert_eq!(decrypted, bundle());
        }
    }

    #[test]
    fn ciphertext_is_nondeterministic_and_opaque() {
        let keyring = test_keyring();
        let a = keyring
            .encrypt("dao.near", CredentialScope::Dao, &bundle())
            .unwrap();
        let b = keyring
            .encrypt("dao.near", CredentialScope::Dao, &bundle())
            .unwrap();
        assert_ne!(a, b);
        let haystack = String::from_utf8_lossy(&a);
        assert!(!haystack.contains("access-token-fixture"));
        assert!(!haystack.contains("refresh-token-fixture"));
    }

    #[test]
    fn wrong_account_or_scope_fails() {
        let keyring = test_keyring();
        let envelope = keyring
            .encrypt("dao.near", CredentialScope::Dao, &bundle())
            .unwrap();
        assert!(matches!(
            keyring.decrypt("other.near", CredentialScope::Dao, &envelope),
            Err(CredentialError::DecryptFailed)
        ));
        assert!(matches!(
            keyring.decrypt("dao.near", CredentialScope::BulkPayment, &envelope),
            Err(CredentialError::DecryptFailed)
        ));
    }

    #[test]
    fn tampered_envelope_fails() {
        let keyring = test_keyring();
        let envelope = keyring
            .encrypt("dao.near", CredentialScope::Dao, &bundle())
            .unwrap();

        let mut flipped_nonce = envelope.clone();
        flipped_nonce[3] ^= 0x01;
        assert!(
            keyring
                .decrypt("dao.near", CredentialScope::Dao, &flipped_nonce)
                .is_err()
        );

        let mut flipped_ct = envelope.clone();
        let last = flipped_ct.len() - 1;
        flipped_ct[last] ^= 0x01;
        assert!(matches!(
            keyring.decrypt("dao.near", CredentialScope::Dao, &flipped_ct),
            Err(CredentialError::DecryptFailed)
        ));

        assert!(matches!(
            keyring.decrypt("dao.near", CredentialScope::Dao, &[]),
            Err(CredentialError::MalformedEnvelope)
        ));
        assert!(matches!(
            keyring.decrypt("dao.near", CredentialScope::Dao, &[9, 0]),
            Err(CredentialError::MalformedEnvelope)
        ));
    }

    #[test]
    fn unknown_key_id_fails() {
        let keyring = test_keyring();
        let envelope = keyring
            .encrypt("dao.near", CredentialScope::Dao, &bundle())
            .unwrap();
        let other = TokenKeyring::parse(
            r#"{"active":"k9","keys":{"k9":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}}"#,
        )
        .unwrap();
        assert!(matches!(
            other.decrypt("dao.near", CredentialScope::Dao, &envelope),
            Err(CredentialError::UnknownKeyId(id)) if id == "k1"
        ));
    }

    #[test]
    fn rotated_keyring_still_decrypts_old_envelopes() {
        let old = TokenKeyring::parse(
            r#"{"active":"k1","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}"#,
        )
        .unwrap();
        let envelope = old
            .encrypt("dao.near", CredentialScope::Dao, &bundle())
            .unwrap();
        let rotated = TokenKeyring::parse(
            r#"{"active":"k2","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","k2":"//////////////////////////////////////////8="}}"#,
        )
        .unwrap();
        let decrypted = rotated
            .decrypt("dao.near", CredentialScope::Dao, &envelope)
            .unwrap();
        assert_eq!(decrypted, bundle());
        let new_envelope = rotated
            .encrypt("dao.near", CredentialScope::Dao, &decrypted)
            .unwrap();
        assert_eq!(new_envelope[2..4], *b"k2");
    }

    #[test]
    fn parse_generation_defaults_and_validates() {
        // Pre-fence configs without a generation keep booting as generation 1.
        assert_eq!(test_keyring().generation(), 1);
        assert_eq!(rotated_keyring().generation(), 2);
        assert!(
            TokenKeyring::parse(
                r#"{"generation":0,"active":"k1","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}"#
            )
            .is_err()
        );
        assert!(
            TokenKeyring::parse(
                r#"{"generation":-3,"active":"k1","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}"#
            )
            .is_err()
        );
    }

    #[test]
    fn active_key_fingerprint_is_stable_and_key_specific() {
        let a = test_keyring();
        assert_eq!(
            a.active_key_fingerprint(),
            test_keyring().active_key_fingerprint()
        );
        assert_eq!(a.active_key_fingerprint().len(), 64);
        assert_ne!(
            a.active_key_fingerprint(),
            rotated_keyring().active_key_fingerprint()
        );
        // Fingerprint never exposes key material (hex sha256, not the key).
        assert!(!a.active_key_fingerprint().contains("AAAA"));
    }

    #[test]
    fn malformed_keyring_rejected() {
        assert!(TokenKeyring::parse("not json").is_err());
        assert!(TokenKeyring::parse(r#"{"active":"k1","keys":{}}"#).is_err());
        assert!(
            TokenKeyring::parse(
                r#"{"active":"k2","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}"#
            )
            .is_err()
        );
        assert!(TokenKeyring::parse(r#"{"active":"k1","keys":{"k1":"dG9vc2hvcnQ="}}"#).is_err());
        assert!(TokenKeyring::parse(r#"{"active":"k1","keys":{"k1":"!!!"}}"#).is_err());
    }

    #[test]
    fn debug_output_is_redacted() {
        let keyring = test_keyring();
        let debug = format!("{:?}", keyring);
        assert!(debug.contains("[REDACTED"));
        assert!(!debug.contains("AAAA"));
        let bundle_debug = format!("{:?}", bundle());
        assert!(!bundle_debug.contains("fixture"));
        assert!(bundle_debug.contains("[REDACTED]"));
    }

    async fn seed_account(pool: &PgPool, account_id: &str) {
        sqlx::query(
            "INSERT INTO monitored_accounts (account_id, is_confidential_account) VALUES ($1, TRUE)",
        )
        .bind(account_id)
        .execute(pool)
        .await
        .expect("seed monitored account");
    }

    fn encrypted_store(pool: PgPool) -> ConfidentialCredentialStore {
        ConfidentialCredentialStore::new(pool, Some(Arc::new(test_keyring())))
    }

    #[sqlx::test]
    async fn store_new_writes_envelope_and_syncs_plaintext(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let store = encrypted_store(pool.clone());
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = 'old-access', confidential_refresh_token = 'old-refresh' WHERE account_id = 'dao.near'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let expires = Utc::now() + chrono::Duration::hours(1);
        store
            .store_new("dao.near", CredentialScope::Dao, &bundle(), expires)
            .await
            .unwrap();

        let (envelope, access, refresh): (Option<Vec<u8>>, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT confidential_credentials_enc, confidential_access_token, confidential_refresh_token FROM monitored_accounts WHERE account_id = 'dao.near'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
        let envelope = envelope.expect("envelope stored");
        // Plaintext kept in sync for rollback until the columns are dropped.
        assert_eq!(access.as_deref(), Some("access-token-fixture"));
        assert_eq!(refresh.as_deref(), Some("refresh-token-fixture"));
        assert!(!String::from_utf8_lossy(&envelope).contains("token-fixture"));

        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .expect("row exists");
        assert!(loaded.from_envelope);
        assert_eq!(loaded.access_token.as_deref(), Some("access-token-fixture"));
        assert_eq!(
            loaded.refresh_token.as_deref(),
            Some("refresh-token-fixture")
        );
        assert_eq!(
            loaded.legacy_refresh_token.as_deref(),
            Some("refresh-token-fixture")
        );
        assert!(loaded.expires_at.is_some());
    }

    #[sqlx::test]
    async fn store_refreshed_syncs_plaintext_and_envelope(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let store = encrypted_store(pool.clone());
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = 'legacy-access', confidential_refresh_token = 'legacy-refresh' WHERE account_id = 'dao.near'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let refreshed = TokenBundle {
            access_token: "new-access".to_string(),
            refresh_token: "legacy-refresh".to_string(),
        };
        store
            .store_refreshed(
                "dao.near",
                CredentialScope::Dao,
                &refreshed,
                Utc::now() + chrono::Duration::hours(1),
            )
            .await
            .unwrap();

        let (envelope, access, refresh): (Option<Vec<u8>>, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT confidential_credentials_enc, confidential_access_token, confidential_refresh_token FROM monitored_accounts WHERE account_id = 'dao.near'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(envelope.is_some());
        assert_eq!(access.as_deref(), Some("new-access"));
        assert_eq!(refresh.as_deref(), Some("legacy-refresh"));

        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(loaded.from_envelope);
        assert_eq!(loaded.access_token.as_deref(), Some("new-access"));
        assert_eq!(loaded.refresh_token.as_deref(), Some("legacy-refresh"));
    }

    #[sqlx::test]
    async fn load_prefers_newer_plaintext_and_heals_envelope(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let store = encrypted_store(pool.clone());
        store
            .store_new(
                "dao.near",
                CredentialScope::Dao,
                &bundle(),
                Utc::now() + chrono::Duration::hours(1),
            )
            .await
            .unwrap();

        // Old-release write during a deploy overlap: plaintext only.
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = 'newer-access', confidential_refresh_token = 'newer-refresh' WHERE account_id = 'dao.near'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(!loaded.from_envelope);
        assert_eq!(loaded.access_token.as_deref(), Some("newer-access"));
        assert_eq!(loaded.refresh_token.as_deref(), Some("newer-refresh"));

        // The envelope healed on first touch: the next load serves the newer
        // pair from the envelope itself.
        let reloaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(reloaded.from_envelope);
        assert_eq!(reloaded.access_token.as_deref(), Some("newer-access"));
        assert_eq!(reloaded.refresh_token.as_deref(), Some("newer-refresh"));
    }

    #[sqlx::test]
    async fn store_on_missing_account_errors(pool: PgPool) {
        let store = encrypted_store(pool.clone());
        let result = store
            .store_new("ghost.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await;
        assert!(matches!(
            result,
            Err(CredentialError::Db(sqlx::Error::RowNotFound))
        ));

        let legacy = ConfidentialCredentialStore::new(pool, None);
        let result = legacy
            .store_refreshed("ghost.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await;
        assert!(matches!(
            result,
            Err(CredentialError::Db(sqlx::Error::RowNotFound))
        ));
    }

    #[sqlx::test]
    async fn plaintext_fallback_and_legacy_mode(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        sqlx::query(
            "UPDATE monitored_accounts SET bulk_payment_access_token = 'pt-access', bulk_payment_refresh_token = 'pt-refresh' WHERE account_id = 'dao.near'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let encrypted = encrypted_store(pool.clone());
        let loaded = encrypted
            .load("dao.near", CredentialScope::BulkPayment)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.access_token.as_deref(), Some("pt-access"));
        assert!(!loaded.from_envelope);
        assert!(loaded.legacy_refresh_token.is_none());

        let legacy = ConfidentialCredentialStore::new(pool.clone(), None);
        let loaded = legacy
            .load("dao.near", CredentialScope::BulkPayment)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.refresh_token.as_deref(), Some("pt-refresh"));
        assert!(
            legacy
                .present("dao.near", CredentialScope::BulkPayment)
                .await
                .unwrap()
        );
        assert!(
            !legacy
                .present("dao.near", CredentialScope::Dao)
                .await
                .unwrap()
        );
        assert!(
            encrypted
                .load("missing.near", CredentialScope::Dao)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[sqlx::test]
    async fn envelope_without_keyring_fails_closed(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let encrypted = encrypted_store(pool.clone());
        encrypted
            .store_new("dao.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await
            .unwrap();

        let legacy = ConfidentialCredentialStore::new(pool, None);
        assert!(matches!(
            legacy.load("dao.near", CredentialScope::Dao).await,
            Err(CredentialError::KeyringMissing)
        ));
    }

    #[sqlx::test]
    async fn backfill_encrypts_complete_pairs_and_reports_partials(pool: PgPool) {
        seed_account(&pool, "complete.near").await;
        seed_account(&pool, "partial.near").await;
        seed_account(&pool, "empty.near").await;
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = 'a1', confidential_refresh_token = 'r1', bulk_payment_access_token = 'ba1', bulk_payment_refresh_token = 'br1' WHERE account_id = 'complete.near'",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = 'a2' WHERE account_id = 'partial.near'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let store = encrypted_store(pool.clone());
        let report = store.reconcile().await.unwrap();
        assert_eq!(report.encrypted, 2);
        assert_eq!(report.failed, 0);
        assert_eq!(
            report.partial,
            vec![("partial.near".to_string(), CredentialScope::Dao)]
        );
        assert!(!report.is_clean());
        // The partial row has no envelope, so the verification sweep keeps
        // rotation pending until that treasury re-authenticates.
        assert_eq!(report.stale_after_sweep, 1);
        assert!(!report.rotation_complete);

        let loaded = store
            .load("complete.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.access_token.as_deref(), Some("a1"));
        let loaded = store
            .load("complete.near", CredentialScope::BulkPayment)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.refresh_token.as_deref(), Some("br1"));

        // Plaintext stays for rollback; rerun is a no-op.
        let (access,): (Option<String>,) = sqlx::query_as(
            "SELECT confidential_access_token FROM monitored_accounts WHERE account_id = 'complete.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(access.as_deref(), Some("a1"));

        let rerun = store.reconcile().await.unwrap();
        assert_eq!(rerun.encrypted, 0);
        assert_eq!(rerun.rotated, 0);
        assert_eq!(rerun.already_encrypted, 2);

        // Legacy-mode reconcile is a no-op.
        let legacy = ConfidentialCredentialStore::new(pool, None);
        let report = legacy.reconcile().await.unwrap();
        assert_eq!(report.encrypted, 0);
    }

    #[sqlx::test]
    async fn reconcile_rotates_stale_key_envelopes(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let old_keyring = TokenKeyring::parse(
            r#"{"active":"k1","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}"#,
        )
        .unwrap();
        let envelope = old_keyring
            .encrypt("dao.near", CredentialScope::Dao, &bundle())
            .unwrap();
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_credentials_enc = $1 WHERE account_id = 'dao.near'",
        )
        .bind(envelope)
        .execute(&pool)
        .await
        .unwrap();

        let store =
            ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(rotated_keyring())));

        let report = store.reconcile().await.unwrap();
        assert_eq!(report.rotated, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(report.stale_after_sweep, 0);
        assert!(report.is_clean());
        // A clean verified sweep — and only that — persists completion.
        assert!(report.rotation_complete);
        let (generation, key_id, _, status, verified_at) = key_state(&pool).await;
        assert_eq!(generation, 2);
        assert_eq!(key_id, "k2");
        assert_eq!(status, "complete");
        assert!(verified_at.is_some());

        let (stored,): (Vec<u8>,) = sqlx::query_as(
            "SELECT confidential_credentials_enc FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(TokenKeyring::envelope_key_id(&stored).unwrap(), "k2");
        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.access_token.as_deref(), Some("access-token-fixture"));

        let rerun = store.reconcile().await.unwrap();
        assert_eq!(rerun.rotated, 0);
        assert_eq!(rerun.already_encrypted, 1);
    }

    #[sqlx::test]
    async fn reconcile_continues_past_undecryptable_rows(pool: PgPool) {
        seed_account(&pool, "broken.near").await;
        seed_account(&pool, "ok.near").await;

        // broken.near: envelope under a key the store's keyring doesn't have.
        let foreign_keyring = TokenKeyring::parse(
            r#"{"active":"k9","keys":{"k9":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}}"#,
        )
        .unwrap();
        let foreign_envelope = foreign_keyring
            .encrypt("broken.near", CredentialScope::Dao, &bundle())
            .unwrap();
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_credentials_enc = $1 WHERE account_id = 'broken.near'",
        )
        .bind(foreign_envelope)
        .execute(&pool)
        .await
        .unwrap();

        // ok.near: plaintext pair still waiting for encryption.
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = 'a', confidential_refresh_token = 'r' WHERE account_id = 'ok.near'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let store = encrypted_store(pool.clone());
        let report = store.reconcile().await.unwrap();
        assert_eq!(report.failed, 1);
        assert_eq!(report.encrypted, 1);
        assert!(!report.is_clean());
        // The undecryptable row keeps rotation pending: the sweep counts it
        // and completion is never persisted while it remains.
        assert_eq!(report.stale_after_sweep, 1);
        assert!(!report.rotation_complete);
        let (_, _, _, status, verified_at) = key_state(&pool).await;
        assert_eq!(status, "pending");
        assert!(verified_at.is_none());

        let loaded = store
            .load("ok.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(loaded.from_envelope);
        assert_eq!(loaded.access_token.as_deref(), Some("a"));
    }

    #[sqlx::test]
    async fn key_state_bootstrap_promote_and_reject(pool: PgPool) {
        let gen1 = encrypted_store(pool.clone());
        gen1.ensure_key_state().await.unwrap();
        let (generation, key_id, fingerprint, status, verified_at) = key_state(&pool).await;
        assert_eq!(generation, 1);
        assert_eq!(key_id, "k1");
        assert_eq!(fingerprint, test_keyring().active_key_fingerprint());
        assert_eq!(status, "pending");
        assert!(verified_at.is_none());

        // Re-registering the same keyring is idempotent.
        gen1.ensure_key_state().await.unwrap();

        // A second independent keyring — same generation and key id but
        // different key bytes — cannot claim this schema.
        let imposter_keyring = TokenKeyring::parse(
            r#"{"active":"k1","keys":{"k1":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}}"#,
        )
        .unwrap();
        let imposter =
            ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(imposter_keyring)));
        assert!(matches!(
            imposter.ensure_key_state().await,
            Err(CredentialError::KeyStateConflict(_))
        ));

        // Promotion to generation 2 marks the rotation pending again.
        let gen2 =
            ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(rotated_keyring())));
        gen2.ensure_key_state().await.unwrap();
        let (generation, key_id, _, status, verified_at) = key_state(&pool).await;
        assert_eq!(generation, 2);
        assert_eq!(key_id, "k2");
        assert_eq!(status, "pending");
        assert!(verified_at.is_none());

        // The old generation is rejected outright — a stale pod must fail boot.
        assert!(matches!(
            gen1.ensure_key_state().await,
            Err(CredentialError::StaleKeyGeneration {
                configured: 1,
                persisted: 2
            })
        ));
    }

    #[sqlx::test]
    async fn stale_generation_pod_cannot_write(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let gen2 =
            ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(rotated_keyring())));
        gen2.ensure_key_state().await.unwrap();

        // A pod still holding the generation-1 keyring cannot seal an
        // envelope under the decommission-pending key — not even into a
        // previously empty row, which no envelope CAS could have protected.
        let gen1 = encrypted_store(pool.clone());
        let result = gen1
            .store_new("dao.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await;
        assert!(matches!(
            result,
            Err(CredentialError::StaleKeyGeneration { .. })
        ));
        let (envelope,): (Option<Vec<u8>>,) = sqlx::query_as(
            "SELECT confidential_credentials_enc FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(envelope.is_none());

        // The promoted keyring writes normally.
        gen2.store_new("dao.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await
            .unwrap();
        let (envelope,): (Option<Vec<u8>>,) = sqlx::query_as(
            "SELECT confidential_credentials_enc FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            TokenKeyring::envelope_key_id(&envelope.unwrap()).unwrap(),
            "k2"
        );
    }

    #[sqlx::test]
    async fn heal_cas_loss_leaves_concurrent_write_untouched(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let store = encrypted_store(pool.clone());
        store
            .store_new("dao.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await
            .unwrap();
        let (current,): (Vec<u8>,) = sqlx::query_as(
            "SELECT confidential_credentials_enc FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        // A repair write whose envelope snapshot no longer matches (a
        // concurrent authoritative write won) skips instead of clobbering.
        let keyring = test_keyring();
        let stale_envelope = keyring
            .encrypt("dao.near", CredentialScope::Dao, &bundle())
            .unwrap();
        let stale_pair = TokenBundle {
            access_token: "stale-access".to_string(),
            refresh_token: "stale-refresh".to_string(),
        };
        let written = store
            .write_encrypted_synced(
                &keyring,
                "dao.near",
                CredentialScope::Dao,
                &stale_pair,
                None,
                Some(&RowSnapshot {
                    envelope: &stale_envelope,
                    plaintext_access: "access-token-fixture",
                    plaintext_refresh: "refresh-token-fixture",
                }),
            )
            .await
            .unwrap();
        assert!(!written);

        let (after,): (Vec<u8>,) = sqlx::query_as(
            "SELECT confidential_credentials_enc FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, current);
        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.access_token.as_deref(), Some("access-token-fixture"));
    }

    #[sqlx::test]
    async fn heal_yields_to_concurrent_legacy_plaintext_write(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let store = encrypted_store(pool.clone());
        store
            .store_new("dao.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await
            .unwrap();
        let (current,): (Vec<u8>,) = sqlx::query_as(
            "SELECT confidential_credentials_enc FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        // A legacy plaintext-only pod refreshes between the heal's read and
        // its write: the envelope bytes are UNCHANGED, only the plaintext
        // moved. The heal — holding the older plaintext in its snapshot —
        // must skip, or it would overwrite the newer tokens.
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = 'legacy-newer-access', confidential_refresh_token = 'legacy-newer-refresh' WHERE account_id = 'dao.near'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let keyring = test_keyring();
        let written = store
            .write_encrypted_synced(
                &keyring,
                "dao.near",
                CredentialScope::Dao,
                &bundle(),
                None,
                Some(&RowSnapshot {
                    envelope: &current,
                    plaintext_access: "access-token-fixture",
                    plaintext_refresh: "refresh-token-fixture",
                }),
            )
            .await
            .unwrap();
        assert!(!written);
        let (access, refresh): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT confidential_access_token, confidential_refresh_token FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(access.as_deref(), Some("legacy-newer-access"));
        assert_eq!(refresh.as_deref(), Some("legacy-newer-refresh"));

        // End-to-end: load sees the divergent pair, heals with a consistent
        // snapshot, and the healed envelope carries the legacy pod's tokens.
        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.access_token.as_deref(), Some("legacy-newer-access"));
        let reloaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(reloaded.from_envelope);
        assert_eq!(
            reloaded.access_token.as_deref(),
            Some("legacy-newer-access")
        );
    }

    #[sqlx::test]
    async fn partial_plaintext_drops_expiry_to_force_refresh(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let store = encrypted_store(pool.clone());
        store
            .store_new(
                "dao.near",
                CredentialScope::Dao,
                &bundle(),
                Utc::now() + chrono::Duration::hours(1),
            )
            .await
            .unwrap();

        // access-present / refresh-missing with a fresh future expiry: the
        // expiry belongs to whatever legacy write left the row partial and
        // must not vouch for the envelope's access token — no expiry forces
        // the refresh path to validate with 1Click before serving.
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_refresh_token = NULL, confidential_token_expires_at = NOW() + INTERVAL '2 hours' WHERE account_id = 'dao.near'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(loaded.from_envelope);
        assert!(loaded.expires_at.is_none());
        assert_eq!(loaded.access_token.as_deref(), Some("access-token-fixture"));
        assert_eq!(
            loaded.refresh_token.as_deref(),
            Some("refresh-token-fixture")
        );
        assert!(loaded.legacy_refresh_token.is_none());

        // refresh-present / access-missing: expiry dropped too, and the
        // plaintext refresh token stays available for the 401 fallback.
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = NULL, confidential_refresh_token = 'legacy-refresh' WHERE account_id = 'dao.near'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(loaded.expires_at.is_none());
        assert_eq!(
            loaded.legacy_refresh_token.as_deref(),
            Some("legacy-refresh")
        );

        // A complete synced pair keeps its expiry.
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_access_token = 'access-token-fixture', confidential_refresh_token = 'refresh-token-fixture' WHERE account_id = 'dao.near'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let loaded = store
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(loaded.from_envelope);
        assert!(loaded.expires_at.is_some());
    }

    #[sqlx::test]
    async fn stale_pod_plaintext_fallback_heals_on_next_load(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let gen1 = encrypted_store(pool.clone());
        gen1.ensure_key_state().await.unwrap();
        gen1.store_new("dao.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await
            .unwrap();

        let gen2 =
            ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(rotated_keyring())));
        gen2.ensure_key_state().await.unwrap();

        // The vote-relay flow on the stale pod: the fenced write is
        // rejected AFTER 1Click issued the pair, so it falls back to the
        // plaintext-only write, leaving the k1 envelope untouched.
        let issued = TokenBundle {
            access_token: "issued-access".to_string(),
            refresh_token: "issued-refresh".to_string(),
        };
        let expires = Utc::now() + chrono::Duration::hours(1);
        assert!(matches!(
            gen1.store_new("dao.near", CredentialScope::Dao, &issued, expires)
                .await,
            Err(CredentialError::StaleKeyGeneration { .. })
        ));
        gen1.store_new_plaintext_fallback("dao.near", CredentialScope::Dao, &issued, expires)
            .await
            .unwrap();
        let (envelope,): (Vec<u8>,) = sqlx::query_as(
            "SELECT confidential_credentials_enc FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(TokenKeyring::envelope_key_id(&envelope).unwrap(), "k1");

        // The next load on an up-to-date pod serves the issued pair and
        // heals it into an active-key envelope.
        let loaded = gen2
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.access_token.as_deref(), Some("issued-access"));
        let (envelope,): (Vec<u8>,) = sqlx::query_as(
            "SELECT confidential_credentials_enc FROM monitored_accounts WHERE account_id = 'dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(TokenKeyring::envelope_key_id(&envelope).unwrap(), "k2");
        let reloaded = gen2
            .load("dao.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(reloaded.from_envelope);
        assert_eq!(reloaded.access_token.as_deref(), Some("issued-access"));
        assert_eq!(reloaded.refresh_token.as_deref(), Some("issued-refresh"));
    }

    #[sqlx::test]
    async fn promotion_requires_previous_active_key_unchanged(pool: PgPool) {
        let gen1 = encrypted_store(pool.clone());
        gen1.ensure_key_state().await.unwrap();

        // Promotion with a keyring that dropped k1 must fail boot: existing
        // envelopes under k1 could never be decrypted for rotation.
        let dropped_k1 = TokenKeyring::parse(
            r#"{"generation":2,"active":"k2","keys":{"k2":"//////////////////////////////////////////8="}}"#,
        )
        .unwrap();
        let store = ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(dropped_k1)));
        assert!(matches!(
            store.ensure_key_state().await,
            Err(CredentialError::KeyStateConflict(_))
        ));

        // Promotion that reuses id k1 with different bytes must fail boot:
        // envelope headers still name k1, so those rows would be
        // unrepairable.
        let reused_k1 = TokenKeyring::parse(
            r#"{"generation":2,"active":"k2","keys":{"k1":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","k2":"//////////////////////////////////////////8="}}"#,
        )
        .unwrap();
        let store = ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(reused_k1)));
        assert!(matches!(
            store.ensure_key_state().await,
            Err(CredentialError::KeyStateConflict(_))
        ));

        // The persisted state is untouched by the rejected promotions, and a
        // keyring retaining k1 correctly still promotes.
        let (generation, _, _, _, _) = key_state(&pool).await;
        assert_eq!(generation, 1);
        let gen2 =
            ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(rotated_keyring())));
        gen2.ensure_key_state().await.unwrap();
        let (generation, key_id, _, _, _) = key_state(&pool).await;
        assert_eq!((generation, key_id.as_str()), (2, "k2"));
    }

    #[sqlx::test]
    async fn dirty_sweep_demotes_persisted_completion(pool: PgPool) {
        seed_account(&pool, "dao.near").await;
        let store = encrypted_store(pool.clone());
        store
            .store_new("dao.near", CredentialScope::Dao, &bundle(), Utc::now())
            .await
            .unwrap();
        let report = store.reconcile().await.unwrap();
        assert!(report.rotation_complete);
        let (_, _, _, status, _) = key_state(&pool).await;
        assert_eq!(status, "complete");

        // A row without a verified active-key envelope appears afterwards
        // (backup restore, manual edit): the next sweep must take the
        // persisted status back to pending — it must never say complete
        // while such a row exists.
        seed_account(&pool, "restored.near").await;
        let foreign_keyring = TokenKeyring::parse(
            r#"{"active":"k9","keys":{"k9":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}}"#,
        )
        .unwrap();
        let foreign_envelope = foreign_keyring
            .encrypt("restored.near", CredentialScope::Dao, &bundle())
            .unwrap();
        sqlx::query(
            "UPDATE monitored_accounts SET confidential_credentials_enc = $1 WHERE account_id = 'restored.near'",
        )
        .bind(foreign_envelope)
        .execute(&pool)
        .await
        .unwrap();

        let report = store.reconcile().await.unwrap();
        assert!(!report.rotation_complete);
        assert_eq!(report.stale_after_sweep, 1);
        let (_, _, _, status, verified_at) = key_state(&pool).await;
        assert_eq!(status, "pending");
        assert!(verified_at.is_none());
    }
}
