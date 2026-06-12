//! Decode a relayed delegate action (direct meta-transaction or `w_execute_signed`)
//! into the homogeneous [`RelayOperation`] the relay sponsors.

mod proposal;
mod wallet;

pub use proposal::{
    ActProposal, ParsedRelay, ProposalInput, RelayOperation, parse_sponsored_proposals,
};
pub(crate) use wallet::{build_sponsored_actions, is_wallet_contract_action};
