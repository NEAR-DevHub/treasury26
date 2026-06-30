//! Per-DAO confidential bulk-payment subaccount.
//!
//! Deployed via `bulk-payment.near` factory at `<dao_prefix>.bulk-payment.near`.
//! Stores N payload hashes from an Approved sputnik-dao FunctionCall proposal,
//! then signs each through `v1.signer` MPC on caller-driven `ping` calls.
//!
//! Trust model: the activation hash list is read from the DAO proposal on-chain
//! via `get_proposal`, never from caller input — so `activate` and `ping` are
//! safe to expose permissionlessly. The DAO already authenticated proposal
//! creation; we only progress what the DAO already approved.

mod intents;
mod mpc;
mod sputnik;
mod views;

use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near, require,
};

use crate::intents::ext_intents;
use crate::mpc::{PayloadV2, SignRequest, SignatureResponse, ext_v1_signer};
#[cfg(test)]
use crate::sputnik::{FCAction, FCKind};
use crate::sputnik::{ProposalKind, SputnikProposal, ext_sputnik};

const V1_SIGNER: &str = "v1.signer";
const INTENTS: &str = "intents.near";

pub const SIGN_GAS: Gas = Gas::from_tgas(8);
pub const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(5);
pub const SIGN_RESERVE_GAS: Gas = Gas::from_tgas(5);
pub const FETCH_PROPOSAL_GAS: Gas = Gas::from_tgas(5);
pub const ACTIVATE_CALLBACK_GAS: Gas = Gas::from_tgas(8);
pub const DERIVE_PUBKEY_GAS: Gas = Gas::from_tgas(5);
pub const ADD_PUBKEY_GAS: Gas = Gas::from_tgas(5);
pub const BOOTSTRAP_CALLBACK_GAS: Gas = Gas::from_tgas(5);
/// Gas reserved for the tail of `on_get_proposal` after the chained ping is
/// scheduled — covers the ping promise's own scheduling cost, the refund
/// Promise's scheduling cost, and finishing the fn.
pub const ON_GET_PROPOSAL_TAIL_GAS: Gas = Gas::from_tgas(10);

pub const MAX_HASHES_PER_ACTIVATION: usize = 200;
const HASH_HEX_LEN: usize = 64;

/// Worst-case bytes per `HashEntry` borsh-encoded, calibrated against
/// integration-test measurements (see `test_gas_and_storage_metrics`).
/// Measured ~135 bytes/hash with `Signed { signature: [u8; 64] }`; ~10% headroom.
pub const BYTES_PER_HASH: u64 = 150;

/// Worst-case bytes per `Activation` minus its `hashes` Vec.
/// Measured ~150 bytes; small safety bump.
pub const BYTES_PER_ACTIVATION: u64 = 170;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BootstrapFailureReason {
    DerivedPublicKeyCallFailed,
    AddPublicKeyCallFailed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BootstrapStatus {
    Pending,
    InProgress,
    Ready {
        mpc_public_key: String,
        dao_mpc_public_key: String,
    },
    Failed {
        reason: BootstrapFailureReason,
    },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HashInvalidReason {
    MalformedHex,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignFailureReason {
    SignerCallFailed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActivationStatus {
    Loading,
    Ready { cursor: u32 },
    Done,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HashStatus {
    Pending,
    Signing,
    Signed { signature: Base64VecU8 },
    SignFailed { reason: SignFailureReason },
    Invalid { reason: HashInvalidReason },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct HashEntry {
    pub payload_hash: String,
    pub status: HashStatus,
}

impl HashEntry {
    /// Create an entry from raw input. Bad hashes get `Invalid` status
    /// rather than aborting the activation, mirroring `PaymentRecord` in the
    /// public bulk-payment contract.
    pub fn from_raw(raw: &str) -> Self {
        let trimmed = raw.trim();
        let status = if trimmed.len() == HASH_HEX_LEN
            && trimmed
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            HashStatus::Pending
        } else {
            HashStatus::Invalid {
                reason: HashInvalidReason::MalformedHex,
            }
        };
        Self {
            payload_hash: trimmed.to_string(),
            status,
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Activation {
    pub status: ActivationStatus,
    pub hashes: Vec<HashEntry>,
    /// Count of entries still in `Pending` or `Signing` (i.e. not in a
    /// terminal state). Lets `on_sign` decide whether to flip to `Done`
    /// without scanning the full hash list each callback.
    pub unresolved: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_dao: AccountId,
    bootstrap: BootstrapStatus,
    activations: IterableMap<u64, Activation>,
}

#[near]
impl Contract {
    /// Initialize the subaccount. Called once by the factory.
    ///
    /// The naming binding (`current_account_id == "<prefix>.<factory>"` and
    /// `owner_dao == "<prefix>.sputnik-dao.<network>"`) is enforced by the
    /// factory in `create_confidential_subaccount`. This `init` itself accepts
    /// any `owner_dao` so that a contract can be deployed manually (e.g. for
    /// dev/testing) and pointed at an arbitrary DAO.
    #[init]
    pub fn init(owner_dao: AccountId) -> Self {
        Self {
            owner_dao,
            bootstrap: BootstrapStatus::Pending,
            activations: IterableMap::new(b"a"),
        }
    }

    // ── Bootstrap ───────────────────────────────────────────────────────────

    /// Fetch MPC pubkey from v1.signer and register it on intents.near.
    /// Permissionless. Idempotent in `Pending`/`Failed` states.
    /// Derive both the contract's and the DAO's MPC pubkeys in parallel,
    /// then register both on intents.near in parallel. Registering the DAO's
    /// key under this contract's intents account lets the DAO sign intents
    /// that draw from this contract's intents balance (e.g. for recovery).
    /// Permissionless. Idempotent in `Pending`/`Failed` states.
    pub fn bootstrap(&mut self) -> Promise {
        require!(
            matches!(
                self.bootstrap,
                BootstrapStatus::Pending | BootstrapStatus::Failed { .. }
            ),
            "bootstrap not in Pending/Failed state"
        );
        self.bootstrap = BootstrapStatus::InProgress;

        let signer: AccountId = V1_SIGNER.parse().unwrap();
        let derive_self = ext_v1_signer::ext(signer.clone())
            .with_static_gas(DERIVE_PUBKEY_GAS)
            .derived_public_key(String::new(), env::current_account_id(), 1);
        let derive_dao = ext_v1_signer::ext(signer)
            .with_static_gas(DERIVE_PUBKEY_GAS)
            .derived_public_key(String::new(), self.owner_dao.clone(), 1);

        // Tail after the join: on_both_derived + 2× add_public_key + on_both_added.
        let tail_gas = BOOTSTRAP_CALLBACK_GAS
            .saturating_add(ADD_PUBKEY_GAS.saturating_mul(2))
            .saturating_add(BOOTSTRAP_CALLBACK_GAS);

        derive_self.and(derive_dao).then(
            Self::ext(env::current_account_id())
                .with_static_gas(tail_gas)
                .on_both_derived(),
        )
    }

    #[private]
    pub fn on_both_derived(
        &mut self,
        #[callback_result] self_pk: Result<String, PromiseError>,
        #[callback_result] dao_pk: Result<String, PromiseError>,
    ) -> Option<Promise> {
        let (self_pk, dao_pk) = match (self_pk, dao_pk) {
            (Ok(s), Ok(d)) => (s, d),
            _ => {
                self.bootstrap = BootstrapStatus::Failed {
                    reason: BootstrapFailureReason::DerivedPublicKeyCallFailed,
                };
                return None;
            }
        };

        let intents: AccountId = INTENTS.parse().unwrap();
        let add_self = ext_intents::ext(intents.clone())
            .with_static_gas(ADD_PUBKEY_GAS)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .add_public_key(self_pk.clone());
        let add_dao = ext_intents::ext(intents)
            .with_static_gas(ADD_PUBKEY_GAS)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .add_public_key(dao_pk.clone());

        Some(
            add_self.and(add_dao).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(BOOTSTRAP_CALLBACK_GAS)
                    .on_both_added(self_pk, dao_pk),
            ),
        )
    }

    #[private]
    pub fn on_both_added(
        &mut self,
        mpc_public_key: String,
        dao_mpc_public_key: String,
        #[callback_result] self_res: Result<(), PromiseError>,
        #[callback_result] dao_res: Result<(), PromiseError>,
    ) {
        match (self_res, dao_res) {
            (Ok(_), Ok(_)) => {
                self.bootstrap = BootstrapStatus::Ready {
                    mpc_public_key,
                    dao_mpc_public_key,
                };
            }
            _ => {
                self.bootstrap = BootstrapStatus::Failed {
                    reason: BootstrapFailureReason::AddPublicKeyCallFailed,
                };
            }
        }
    }

    // ── Activation ──────────────────────────────────────────────────────────

    /// Worst-case deposit required by `activate`: storage for a fully-loaded
    /// activation plus 1 yoctoNEAR per hash for the per-`sign` deposit.
    pub fn activate_required_deposit(&self) -> NearToken {
        Self::cost_for_hashes(MAX_HASHES_PER_ACTIVATION as u64)
    }

    fn cost_for_hashes(num_hashes: u64) -> NearToken {
        let storage_bytes = BYTES_PER_HASH
            .saturating_mul(num_hashes)
            .saturating_add(BYTES_PER_ACTIVATION);
        let storage_yocto = env::storage_byte_cost()
            .as_yoctonear()
            .saturating_mul(storage_bytes as u128);
        let sign_yocto = num_hashes as u128; // 1 yocto per sign call
        NearToken::from_yoctonear(storage_yocto.saturating_add(sign_yocto))
    }

    /// Load the hash list for `proposal_id` from the owner DAO.
    /// Permissionless — the source of truth is the on-chain proposal.
    /// Caller must attach at least `activate_required_deposit()`. Excess is
    /// refunded once the actual hash count is known (in `on_get_proposal`).
    #[payable]
    pub fn activate(&mut self, proposal_id: U64) -> Option<Promise> {
        require!(
            matches!(self.bootstrap, BootstrapStatus::Ready { .. }),
            "bootstrap not Ready"
        );

        let pid: u64 = proposal_id.into();

        if let Some(existing) = self.activations.get(&pid) {
            match existing.status {
                ActivationStatus::Ready { .. } | ActivationStatus::Done => {
                    env::log_str("activate: already loaded");
                    // Refund the full attached deposit — the activation is
                    // already paid for, so any NEAR forwarded by the caller
                    // would otherwise be silently absorbed by `#[payable]`.
                    let attached = env::attached_deposit();
                    if attached.as_yoctonear() > 0 {
                        return Some(
                            Promise::new(env::predecessor_account_id()).transfer(attached),
                        );
                    }
                    return None;
                }
                ActivationStatus::Loading => {
                    env::panic_str("activation already in progress");
                }
            }
        }

        let required = self.activate_required_deposit();
        let attached = env::attached_deposit();
        require!(
            attached >= required,
            format!(
                "insufficient deposit: required {} yocto, attached {} yocto",
                required.as_yoctonear(),
                attached.as_yoctonear()
            )
        );

        self.activations.insert(
            pid,
            Activation {
                status: ActivationStatus::Loading,
                hashes: vec![],
                unresolved: 0,
            },
        );

        // Forward the predecessor + attached deposit through to the callback
        // so we can refund the unused portion without storing per-activation
        // refund metadata on chain.
        let payer = env::predecessor_account_id();
        Some(
            ext_sputnik::ext(self.owner_dao.clone())
                .with_static_gas(FETCH_PROPOSAL_GAS)
                .get_proposal(pid)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(ACTIVATE_CALLBACK_GAS)
                        .on_get_proposal(proposal_id, payer, attached),
                ),
        )
    }

    #[private]
    pub fn on_get_proposal(
        &mut self,
        proposal_id: U64,
        payer: AccountId,
        attached: NearToken,
        #[callback_result] result: Result<SputnikProposal, PromiseError>,
    ) -> Option<Promise> {
        let pid: u64 = proposal_id.into();
        let proposal = match result {
            Ok(p) => p,
            Err(_) => {
                return self.abort_loading(pid, &payer, attached, "on_get_proposal: fetch failed");
            }
        };

        if proposal.status != "Approved" {
            return self.abort_loading(
                pid,
                &payer,
                attached,
                "on_get_proposal: proposal not Approved",
            );
        }

        let fc = match &proposal.kind {
            ProposalKind::FunctionCall(fc) => fc,
            ProposalKind::Other => {
                return self.abort_loading(
                    pid,
                    &payer,
                    attached,
                    "on_get_proposal: not a FunctionCall proposal",
                );
            }
        };

        if fc.receiver_id.as_str() != V1_SIGNER {
            return self.abort_loading(
                pid,
                &payer,
                attached,
                "on_get_proposal: receiver is not v1.signer",
            );
        }

        let header_action = match fc.actions.first() {
            Some(a) => a,
            None => {
                return self.abort_loading(pid, &payer, attached, "on_get_proposal: no actions");
            }
        };
        if header_action.method_name != "sign" {
            return self.abort_loading(
                pid,
                &payer,
                attached,
                "on_get_proposal: header action is not sign",
            );
        }

        let csv = match proposal.description_field("payload_hashes") {
            Some(v) => v,
            None => {
                return self.abort_loading(
                    pid,
                    &payer,
                    attached,
                    "on_get_proposal: payload_hashes missing",
                );
            }
        };

        let hashes: Vec<HashEntry> = csv.split(',').map(HashEntry::from_raw).collect();

        if hashes.is_empty() || hashes.len() > MAX_HASHES_PER_ACTIVATION {
            return self.abort_loading(
                pid,
                &payer,
                attached,
                "on_get_proposal: hash count out of range",
            );
        }

        let actual_cost = Self::cost_for_hashes(hashes.len() as u64);
        // Defensive: `activate` already requires `attached >= cost_for_hashes(MAX)`,
        // so any N ≤ MAX should satisfy `actual_cost <= attached`. If a future
        // change to `cost_for_hashes` breaks that invariant, abort + refund
        // rather than silently underfunding the activation's storage.
        if actual_cost > attached {
            return self.abort_loading(
                pid,
                &payer,
                attached,
                "on_get_proposal: actual cost exceeds attached deposit",
            );
        }
        let refund = attached.saturating_sub(actual_cost);

        let activation = self
            .activations
            .get_mut(&pid)
            .unwrap_or_else(|| env::panic_str("activation not found"));
        activation.unresolved = hashes
            .iter()
            .filter(|h| matches!(h.status, HashStatus::Pending))
            .count() as u32;
        activation.status = ActivationStatus::Ready { cursor: 0 };
        activation.hashes = hashes;

        // All hashes malformed → no work to do, mark Done immediately.
        if activation.unresolved == 0 {
            activation.status = ActivationStatus::Done;
        }

        // Refund excess deposit as a detached side promise (scheduled via
        // `promise_create`) so we can return the chained ping Promise as the
        // function's primary result. Returning a joint `refund.and(ping)` is
        // prohibited by the runtime.
        if refund.as_yoctonear() > 0 {
            Promise::new(payer).transfer(refund).detach();
        }

        // Chain the first ping so callers don't need a follow-up tx for the
        // happy path. Forward all leftover prepaid gas (minus a small reserve
        // for finishing this receipt) so a worker can size the dispatch batch
        // by setting the `activate` tx gas.
        let remaining = env::prepaid_gas().saturating_sub(env::used_gas());
        let ping_gas = remaining.saturating_sub(ON_GET_PROPOSAL_TAIL_GAS);
        Some(
            Self::ext(env::current_account_id())
                .with_static_gas(ping_gas)
                .ping(proposal_id),
        )
    }

    /// Drop a Loading activation and refund the full attached deposit.
    fn abort_loading(
        &mut self,
        pid: u64,
        payer: &AccountId,
        attached: NearToken,
        reason: &str,
    ) -> Option<Promise> {
        env::log_str(reason);
        self.activations.remove(&pid);
        if attached.as_yoctonear() > 0 {
            Some(Promise::new(payer.clone()).transfer(attached))
        } else {
            None
        }
    }

    // ── Ping (sign next batch of hashes) ────────────────────────────────────

    /// Dispatch `sign` for as many Pending hashes as remaining gas allows.
    /// Each dispatch installs a callback that flips the entry to `Signed` or
    /// `SignFailed` based on the receipt outcome. Returns count dispatched.
    pub fn ping(&mut self, proposal_id: U64) -> u32 {
        let pid: u64 = proposal_id.into();

        let activation = self
            .activations
            .get_mut(&pid)
            .unwrap_or_else(|| env::panic_str("activation not found"));

        let mut cursor = match activation.status {
            ActivationStatus::Ready { cursor } => cursor,
            _ => env::panic_str("activation not Ready"),
        };

        let total = activation.hashes.len() as u32;
        let mut dispatched: u32 = 0;

        while cursor < total {
            let entry = &mut activation.hashes[cursor as usize];

            // Skip entries that aren't Pending (already Signing/Signed/Invalid/SignFailed).
            if entry.status != HashStatus::Pending {
                cursor += 1;
                continue;
            }

            let prepaid = env::prepaid_gas();
            let used = env::used_gas();
            let remaining = prepaid.saturating_sub(used);
            if remaining < SIGN_GAS.saturating_add(SIGN_RESERVE_GAS) {
                break;
            }

            let request = SignRequest {
                path: String::new(),
                payload_v2: PayloadV2::Eddsa(entry.payload_hash.clone()),
                domain_id: 1,
            };

            ext_v1_signer::ext(V1_SIGNER.parse().unwrap())
                .with_static_gas(SIGN_GAS)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .sign(request)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(SIGN_CALLBACK_GAS)
                        .on_sign(proposal_id, cursor),
                )
                .detach();

            entry.status = HashStatus::Signing;
            cursor += 1;
            dispatched += 1;
        }

        // Terminal `Done` is set by `on_sign` once no entries remain in
        // `Pending`/`Signing`. `ping` only advances the cursor — even when
        // `cursor == total`, in-flight `Signing` entries may still resolve.
        activation.status = ActivationStatus::Ready { cursor };

        dispatched
    }

    /// Resolve a single hash's signing result from the v1.signer callback.
    #[private]
    pub fn on_sign(
        &mut self,
        proposal_id: U64,
        index: u32,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) {
        let pid: u64 = proposal_id.into();
        let Some(activation) = self.activations.get_mut(&pid) else {
            return;
        };
        {
            let Some(entry) = activation.hashes.get_mut(index as usize) else {
                return;
            };

            // Only flip if we're still in Signing — guards against double-callbacks
            // or manual state surgery.
            if entry.status != HashStatus::Signing {
                return;
            }

            entry.status = match result {
                Ok(SignatureResponse::Ed25519 { signature }) if signature.len() == 64 => {
                    HashStatus::Signed {
                        signature: signature.into(),
                    }
                }
                _ => HashStatus::SignFailed {
                    reason: SignFailureReason::SignerCallFailed,
                },
            };
        }

        // Promote to `Done` once the unresolved counter hits zero. `ping`
        // does not set `Done` itself, so the last-arriving callback is
        // responsible for closing out the activation.
        activation.unresolved = activation.unresolved.saturating_sub(1);
        if activation.unresolved == 0 {
            activation.status = ActivationStatus::Done;
        }
    }

    /// Reset `SignFailed` entries back to `Pending` so a future `ping` will
    /// retry them. Permissionless. Also moves the activation back to `Ready`
    /// if it was `Done`, so the cursor will advance through retried entries.
    pub fn retry_failed(&mut self, proposal_id: U64) -> u32 {
        let pid: u64 = proposal_id.into();
        let activation = self
            .activations
            .get_mut(&pid)
            .unwrap_or_else(|| env::panic_str("activation not found"));

        let mut reset = 0u32;
        let mut first_failed: Option<u32> = None;
        for (i, entry) in activation.hashes.iter_mut().enumerate() {
            if matches!(entry.status, HashStatus::SignFailed { .. }) {
                entry.status = HashStatus::Pending;
                reset += 1;
                if first_failed.is_none() {
                    first_failed = Some(i as u32);
                }
            }
        }

        if reset > 0 {
            activation.unresolved = activation.unresolved.saturating_add(reset);
            activation.status = ActivationStatus::Ready {
                cursor: first_failed.unwrap_or(0),
            };
        }
        reset
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(current: &str, predecessor: &str) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .signer_account_id(predecessor.parse().unwrap())
            .prepaid_gas(Gas::from_tgas(300));
        b
    }

    #[test]
    fn init_accepts_any_dao() {
        // Naming binding is enforced by the factory; init itself is permissive.
        testing_env!(ctx("mydao.bulk-payment.near", "factory.near").build());
        let c = Contract::init("mydao.sputnik-dao.near".parse().unwrap());
        assert_eq!(c.owner_dao.as_str(), "mydao.sputnik-dao.near");
        assert!(matches!(c.bootstrap, BootstrapStatus::Pending));

        testing_env!(ctx("dev.example.near", "alice.near").build());
        let c2 = Contract::init("any-dao.sputnik-dao.near".parse().unwrap());
        assert_eq!(c2.owner_dao.as_str(), "any-dao.sputnik-dao.near");
    }

    fn proposal_with_desc(desc: &str) -> SputnikProposal {
        SputnikProposal {
            kind: ProposalKind::Other,
            description: desc.to_string(),
            status: "Approved".into(),
        }
    }

    #[test]
    fn extract_description_csv_markdown() {
        let p =
            proposal_with_desc("* Proposal Action: confidential <br> * Payload Hashes: aaaa,bbbb");
        assert_eq!(
            p.description_field("payload_hashes").as_deref(),
            Some("aaaa,bbbb")
        );
    }

    #[test]
    fn extract_description_csv_json() {
        let p = proposal_with_desc(r#"{"payload_hashes":"aa,bb"}"#);
        assert_eq!(
            p.description_field("payload_hashes").as_deref(),
            Some("aa,bb")
        );
    }

    #[test]
    fn hash_entry_from_raw() {
        let good = "0".repeat(64);
        assert_eq!(HashEntry::from_raw(&good).status, HashStatus::Pending);
        assert!(matches!(
            HashEntry::from_raw(&"0".repeat(63)).status,
            HashStatus::Invalid { .. }
        ));
        assert!(matches!(
            HashEntry::from_raw(&"G".repeat(64)).status,
            HashStatus::Invalid { .. }
        ));
        // uppercase rejected
        assert!(matches!(
            HashEntry::from_raw(&"A".repeat(64)).status,
            HashStatus::Invalid { .. }
        ));
    }

    fn make_contract() -> Contract {
        testing_env!(ctx("mydao.bulk-payment.near", "factory.near").build());
        let mut c = Contract::init("mydao.sputnik-dao.near".parse().unwrap());
        c.bootstrap = BootstrapStatus::Ready {
            mpc_public_key: "ed25519:fake".into(),
            dao_mpc_public_key: "ed25519:dao_fake".into(),
        };
        c
    }

    #[test]
    #[should_panic(expected = "bootstrap not Ready")]
    fn activate_requires_ready_bootstrap() {
        testing_env!(ctx("mydao.bulk-payment.near", "factory.near").build());
        let mut c = Contract::init("mydao.sputnik-dao.near".parse().unwrap());
        c.activate(U64::from(1));
    }

    #[test]
    fn on_get_proposal_parses_csv() {
        let mut c = make_contract();
        c.activations.insert(
            5,
            Activation {
                status: ActivationStatus::Loading,
                hashes: vec![],
                unresolved: 0,
            },
        );
        let h1 = "a".repeat(64);
        let h2 = "b".repeat(64);
        let desc = format!("* payload_hashes: {h1},{h2}");

        let proposal = SputnikProposal {
            kind: ProposalKind::FunctionCall(FCKind {
                receiver_id: V1_SIGNER.parse().unwrap(),
                actions: vec![FCAction {
                    method_name: "sign".into(),
                    args: "ignored".into(),
                }],
            }),
            description: desc,
            status: "Approved".into(),
        };

        // Direct call (bypassing #[private] gate is fine in unit tests).
        c.activations.insert(
            5,
            Activation {
                status: ActivationStatus::Loading,
                hashes: vec![],
                unresolved: 0,
            },
        );
        // Simulate callback path manually.
        match proposal.status.as_str() {
            "Approved" => {}
            _ => panic!(),
        }
        let csv = proposal.description_field("payload_hashes").unwrap();
        let fc = match proposal.kind {
            ProposalKind::FunctionCall(fc) => fc,
            _ => panic!(),
        };
        assert_eq!(fc.receiver_id.as_str(), V1_SIGNER);
        let parsed: Vec<&str> = csv.split(',').map(|s| s.trim()).collect();
        assert_eq!(parsed, vec![h1.as_str(), h2.as_str()]);
        for h in &parsed {
            assert_eq!(HashEntry::from_raw(h).status, HashStatus::Pending);
        }
    }

    #[test]
    fn on_get_proposal_rejects_non_approved() {
        let mut c = make_contract();
        c.activations.insert(
            7,
            Activation {
                status: ActivationStatus::Loading,
                hashes: vec![],
                unresolved: 0,
            },
        );
        let proposal = SputnikProposal {
            kind: ProposalKind::FunctionCall(FCKind {
                receiver_id: V1_SIGNER.parse().unwrap(),
                actions: vec![FCAction {
                    method_name: "sign".into(),
                    args: "x".into(),
                }],
            }),
            description: format!("* payload_hashes: {}", "a".repeat(64)),
            status: "InProgress".into(),
        };
        c.on_get_proposal(
            U64::from(7),
            "payer.near".parse().unwrap(),
            NearToken::from_yoctonear(0),
            Ok(proposal),
        );
        assert!(c.activations.get(&7).is_none());
    }

    #[test]
    fn on_get_proposal_rejects_wrong_receiver() {
        let mut c = make_contract();
        c.activations.insert(
            8,
            Activation {
                status: ActivationStatus::Loading,
                hashes: vec![],
                unresolved: 0,
            },
        );
        let proposal = SputnikProposal {
            kind: ProposalKind::FunctionCall(FCKind {
                receiver_id: "other.near".parse().unwrap(),
                actions: vec![FCAction {
                    method_name: "sign".into(),
                    args: "x".into(),
                }],
            }),
            description: format!("* payload_hashes: {}", "a".repeat(64)),
            status: "Approved".into(),
        };
        c.on_get_proposal(
            U64::from(8),
            "payer.near".parse().unwrap(),
            NearToken::from_yoctonear(0),
            Ok(proposal),
        );
        assert!(c.activations.get(&8).is_none());
    }

    #[test]
    fn on_get_proposal_loads_hashes() {
        let mut c = make_contract();
        c.activations.insert(
            9,
            Activation {
                status: ActivationStatus::Loading,
                hashes: vec![],
                unresolved: 0,
            },
        );
        let h1 = "a".repeat(64);
        let h2 = "b".repeat(64);
        let proposal = SputnikProposal {
            kind: ProposalKind::FunctionCall(FCKind {
                receiver_id: V1_SIGNER.parse().unwrap(),
                actions: vec![FCAction {
                    method_name: "sign".into(),
                    args: "x".into(),
                }],
            }),
            description: format!("* payload_hashes: {h1},{h2}"),
            status: "Approved".into(),
        };
        // Pass enough deposit to cover the actual cost so on_get_proposal
        // doesn't take the abort-on-underfunded path.
        c.on_get_proposal(
            U64::from(9),
            "payer.near".parse().unwrap(),
            NearToken::from_near(1),
            Ok(proposal),
        );
        let act = c.activations.get(&9).unwrap();
        assert_eq!(act.hashes.len(), 2);
        assert_eq!(act.status, ActivationStatus::Ready { cursor: 0 });
    }
}
