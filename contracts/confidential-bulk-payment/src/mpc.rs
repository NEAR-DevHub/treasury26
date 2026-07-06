//! Mirror of v1.signer types and a typed cross-contract proxy.

use near_sdk::serde_json;
use near_sdk::{AccountId, ext_contract, near};

#[derive(Debug)]
#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: PayloadV2,
    pub domain_id: u32,
}

#[derive(Debug)]
#[near(serializers = [json])]
pub enum PayloadV2 {
    Eddsa(String),
}

/// Mirrors `near_mpc_crypto_types::SignatureResponse` — internally tagged
/// by `scheme`. v1.signer returns this as JSON, e.g.
/// `{ "scheme": "Ed25519", "signature": [..64 bytes..] }`.
#[derive(Debug)]
#[near(serializers = [json])]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1(serde_json::Value),
    Ed25519 { signature: Vec<u8> },
}

#[ext_contract(ext_v1_signer)]
pub trait V1Signer {
    fn derived_public_key(&self, path: String, predecessor: AccountId, domain_id: u32) -> String;
    fn sign(&self, request: SignRequest) -> SignatureResponse;
}
