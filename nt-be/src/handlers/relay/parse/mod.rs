//! Decode a relayed delegate action (direct meta-transaction or `w_execute_signed`)
//! into the homogeneous [`RelayOperation`] the relay sponsors.

mod proposal;
mod wallet_contract;

pub use proposal::{
    ActProposal, ParsedRelay, ProposalInput, RelayOperation, RelayShape, parse_sponsored_proposals,
};
pub(crate) use wallet_contract::build_sponsored_actions;
