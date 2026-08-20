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
//! Every read/write of the token columns must go through
//! [`ConfidentialCredentialStore`] — handlers must not query them directly.

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
use sqlx::PgPool;

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
/// `{"active": "k1", "keys": {"k1": "<base64 32-byte key>"}}`.
/// Non-active keys stay decryptable to support incident rotation.
pub struct TokenKeyring {
    active: String,
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
    active: String,
    keys: HashMap<String, String>,
}

impl TokenKeyring {
    /// Loads the keyring from the environment. Absent/empty → `None`
    /// (legacy plaintext mode); present but invalid → panic, so a
    /// misconfigured deploy fails at boot instead of silently storing
    /// plaintext.
    pub fn from_env() -> Option<Self> {
        let raw = std::env::var(KEYRING_ENV_VAR)
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        match Self::parse(&raw) {
            Ok(keyring) => Some(keyring),
            Err(e) => panic!("Invalid {}: {}", KEYRING_ENV_VAR, e),
        }
    }

    /// Error messages never echo key material or the raw JSON.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let config: KeyringConfig =
            serde_json::from_str(raw).map_err(|_| "not valid keyring JSON".to_string())?;
        if config.keys.is_empty() {
            return Err("keyring has no keys".to_string());
        }
        if !config.keys.contains_key(&config.active) {
            return Err(format!("active key id '{}' not in keys", config.active));
        }
        let mut keys = HashMap::new();
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
            keys.insert(id, SecretBox::new(Box::new(bytes)));
        }
        Ok(Self {
            active: config.active,
            keys,
        })
    }

    pub fn active_key_id(&self) -> &str {
        &self.active
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
}

impl BackfillReport {
    /// A clean run: every credential row is encrypted under the active key.
    pub fn is_clean(&self) -> bool {
        self.failed == 0 && self.partial.is_empty()
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
                if let Err(e) = self
                    .write_encrypted_synced(keyring, account_id, scope, &newer, expires_at)
                    .await
                {
                    // Healing is best-effort — still serve the newer pair.
                    tracing::error!(
                        account_id,
                        scope = scope.as_str(),
                        "failed to heal envelope from plaintext: {}",
                        e
                    );
                }
                return Ok(Some(StoredCredentials {
                    access_token: Some(newer.access_token),
                    refresh_token: Some(newer.refresh_token),
                    expires_at,
                    from_envelope: false,
                    legacy_refresh_token: None,
                }));
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
    /// until the plaintext columns are dropped.
    async fn write_encrypted_synced(
        &self,
        keyring: &TokenKeyring,
        account_id: &str,
        scope: CredentialScope,
        bundle: &TokenBundle,
        expires_at: Option<DateTime<Utc>>,
    ) -> Result<(), CredentialError> {
        let c = scope.columns();
        let envelope = keyring.encrypt(account_id, scope, bundle)?;
        let sql = format!(
            "UPDATE monitored_accounts SET {} = $1, {} = $2, {} = $3, {} = $4 WHERE account_id = $5",
            c.enc, c.expires, c.access, c.refresh
        );
        let result = sqlx::query(&sql)
            .bind(envelope)
            .bind(expires_at)
            .bind(&bundle.access_token)
            .bind(&bundle.refresh_token)
            .bind(account_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(CredentialError::Db(sqlx::Error::RowNotFound));
        }
        Ok(())
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
        let c = scope.columns();
        match &self.keyring {
            Some(keyring) => {
                self.write_encrypted_synced(keyring, account_id, scope, bundle, Some(expires_at))
                    .await
            }
            None => {
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
        }
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
            Some(keyring) => {
                self.write_encrypted_synced(keyring, account_id, scope, bundle, Some(expires_at))
                    .await
            }
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
    pub async fn reconcile(&self) -> Result<BackfillReport, CredentialError> {
        let mut report = BackfillReport {
            encrypted: 0,
            already_encrypted: 0,
            rotated: 0,
            failed: 0,
            partial: Vec::new(),
        };
        let Some(keyring) = self.keyring.as_deref() else {
            return Ok(report);
        };

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
                    tracing::error!(
                        account_id,
                        scope = scope.as_str(),
                        "credential reconcile failed for row: {}",
                        e
                    );
                }
            }
        }
        Ok(report)
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
        // already rewrote the row under the active key wins.
        let sql = format!(
            "UPDATE monitored_accounts SET {} = $1 WHERE account_id = $2 AND {} = $3",
            c.enc, c.enc
        );
        let result = sqlx::query(&sql)
            .bind(new_envelope)
            .bind(account_id)
            .bind(&envelope)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() > 0 {
            report.rotated += 1;
        } else {
            report.already_encrypted += 1;
        }
        Ok(())
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
        let sql = format!(
            "UPDATE monitored_accounts SET {} = $1 WHERE account_id = $2 AND {} IS NULL",
            c.enc, c.enc
        );
        let result = sqlx::query(&sql)
            .bind(envelope)
            .bind(account_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() > 0 {
            report.encrypted += 1;
        } else {
            report.already_encrypted += 1;
        }
        Ok(())
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

    fn bundle() -> TokenBundle {
        TokenBundle {
            access_token: "access-token-fixture".to_string(),
            refresh_token: "refresh-token-fixture".to_string(),
        }
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

        let rotated_keyring = TokenKeyring::parse(
            r#"{"active":"k2","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","k2":"//////////////////////////////////////////8="}}"#,
        )
        .unwrap();
        let store = ConfidentialCredentialStore::new(pool.clone(), Some(Arc::new(rotated_keyring)));

        let report = store.reconcile().await.unwrap();
        assert_eq!(report.rotated, 1);
        assert_eq!(report.failed, 0);
        assert!(report.is_clean());

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

        let loaded = store
            .load("ok.near", CredentialScope::Dao)
            .await
            .unwrap()
            .unwrap();
        assert!(loaded.from_envelope);
        assert_eq!(loaded.access_token.as_deref(), Some("a"));
    }
}
