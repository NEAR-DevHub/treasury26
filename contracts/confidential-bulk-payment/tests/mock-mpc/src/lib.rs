// Mock for v1.signer + intents.near used by confidential-bulk-payment integration tests.
//
// Implements the surface area exercised by the contract:
// - v1.signer: derived_public_key(path, predecessor, domain_id) -> String
// - v1.signer: sign(request) -> { scheme: "Ed25519", signature: <base64> }
// - intents.near: add_public_key(public_key)

use near_sdk::serde_json;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};

#[derive(Debug)]
#[near(serializers = [json])]
pub enum PayloadV2 {
    Eddsa(String),
}

#[derive(Debug)]
#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: PayloadV2,
    pub domain_id: u32,
}

#[derive(Debug)]
#[near(serializers = [json])]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1(serde_json::Value),
    Ed25519 { signature: Vec<u8> },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {}

#[near]
impl MockMpc {
    #[init]
    pub fn new() -> Self {
        Self {}
    }

    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: AccountId,
        domain_id: u32,
    ) -> String {
        let _ = (path, predecessor, domain_id);
        "ed25519:11111111111111111111111111111111".to_string()
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> SignatureResponse {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "mock v1.signer.sign: must attach exactly 1 yoctoNEAR"
        );
        let payload = match request.payload_v2 {
            PayloadV2::Eddsa(s) => s,
        };
        let mut sig = [0u8; 64];
        for (i, b) in payload.bytes().take(64).enumerate() {
            sig[i] = b;
        }
        SignatureResponse::Ed25519 {
            signature: sig.to_vec(),
        }
    }

    #[payable]
    pub fn add_public_key(&mut self, public_key: String) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "mock intents.add_public_key: must attach exactly 1 yoctoNEAR"
        );
        env::log_str(&format!("mock add_public_key: {}", public_key));
    }
}
