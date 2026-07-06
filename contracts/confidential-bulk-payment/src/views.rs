use near_sdk::json_types::U64;
use near_sdk::{AccountId, near};

use crate::{Activation, BootstrapStatus, Contract, ContractExt};

#[near]
impl Contract {
    pub fn get_owner_dao(&self) -> AccountId {
        self.owner_dao.clone()
    }

    pub fn get_public_key(&self) -> Option<String> {
        match &self.bootstrap {
            BootstrapStatus::Ready { mpc_public_key, .. } => Some(mpc_public_key.clone()),
            _ => None,
        }
    }

    pub fn get_dao_public_key(&self) -> Option<String> {
        match &self.bootstrap {
            BootstrapStatus::Ready {
                dao_mpc_public_key, ..
            } => Some(dao_mpc_public_key.clone()),
            _ => None,
        }
    }

    pub fn get_bootstrap_status(&self) -> BootstrapStatus {
        self.bootstrap.clone()
    }

    pub fn get_activation(&self, proposal_id: U64) -> Option<Activation> {
        let pid: u64 = proposal_id.into();
        self.activations.get(&pid).cloned()
    }

    pub fn list_activations(&self, from: U64, limit: u32) -> Vec<(U64, Activation)> {
        let from: u64 = from.into();
        self.activations
            .iter()
            .filter(|(k, _)| **k >= from)
            .take(limit as usize)
            .map(|(k, v)| (U64::from(*k), v.clone()))
            .collect()
    }
}
