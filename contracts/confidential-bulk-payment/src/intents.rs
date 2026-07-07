//! Typed proxy for `intents.near`.

use near_sdk::ext_contract;

#[ext_contract(ext_intents)]
pub trait Intents {
    fn add_public_key(&mut self, public_key: String);
}
