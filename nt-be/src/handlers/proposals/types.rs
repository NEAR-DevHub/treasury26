use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProposalResponse {
    pub page: u64,
    pub page_size: u64,
    pub total: u64,
    pub proposals: Vec<Proposal>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Proposal {
    pub id: u64,
    #[serde(default)]
    pub description: String,
    pub proposer: String,
    pub status: String,
    pub submission_time: String,
    pub kind: serde_json::Value,
    pub vote_counts: Option<HashMap<String, [u64; 3]>>,
    pub votes: Option<HashMap<String, String>>,
    #[serde(skip_deserializing)]
    pub custom_kind: Option<ProposalUIKind>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ProposalKind {
    Transfer {
        amount: String,
        msg: Option<String>,
        receiver_id: String,
        token_id: String,
    },
    FunctionCall {
        receiver_id: String,
        actions: Vec<FunctionCallAction>,
    },
    ChangePolicy {
        policy: serde_json::Value,
    },
    ChangePolicyUpdateParameters {
        parameters: serde_json::Value,
    },
    ChangeConfig {
        config: serde_json::Value,
    },
    AddMemberToRole {
        member_id: String,
        role: String,
    },
    RemoveMemberFromRole {
        member_id: String,
        role: String,
    },
    UpgradeSelf {
        hash: String,
    },
    UpgradeRemote {
        receiver_id: String,
        method_name: String,
        hash: String,
    },
    SetStakingContract {
        staking_id: String,
    },
    AddBounty {
        bounty: serde_json::Value,
    },
    BountyDone {
        bounty_id: u64,
        receiver_id: String,
    },
    Vote,
    FactoryInfoUpdate {
        factory_info: serde_json::Value,
    },
    ChangePolicyAddOrUpdateRole {
        role: serde_json::Value,
    },
    ChangePolicyRemoveRole {
        role: String,
    },
    ChangePolicyUpdateDefaultVotePolicy {
        vote_policy: serde_json::Value,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FunctionCallAction {
    pub args: String,
    pub deposit: String,
    pub gas: String,
    pub method_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Hash)]
pub enum ProposalUIKind {
    #[serde(rename = "Batch Payment Request")]
    BatchPaymentRequest,
    #[serde(rename = "Payment Request")]
    PaymentRequest,
    Exchange,
    #[serde(rename = "Function Call")]
    FunctionCall,
    #[serde(rename = "Change Policy")]
    ChangePolicy,
    #[serde(rename = "Update General Settings")]
    UpdateGeneralSettings,
    #[serde(rename = "Earn NEAR")]
    EarnNear,
    #[serde(rename = "Unstake NEAR")]
    UnstakeNear,
    Vesting,
    #[serde(rename = "Withdraw Earnings")]
    WithdrawEarnings,
    Members,
    Upgrade,
    #[serde(rename = "Set Staking Contract")]
    SetStakingContract,
    Bounty,
    Vote,
    #[serde(rename = "Factory Info Update")]
    FactoryInfoUpdate,
    Unsupported,
}

impl ProposalUIKind {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "Batch Payment Request" => Some(Self::BatchPaymentRequest),
            "Payment Request" => Some(Self::PaymentRequest),
            "Exchange" => Some(Self::Exchange),
            "Function Call" => Some(Self::FunctionCall),
            "Change Policy" => Some(Self::ChangePolicy),
            "Update General Settings" => Some(Self::UpdateGeneralSettings),
            "Earn NEAR" => Some(Self::EarnNear),
            "Unstake NEAR" => Some(Self::UnstakeNear),
            "Vesting" => Some(Self::Vesting),
            "Withdraw Earnings" => Some(Self::WithdrawEarnings),
            "Members" => Some(Self::Members),
            "Upgrade" => Some(Self::Upgrade),
            "Set Staking Contract" => Some(Self::SetStakingContract),
            "Bounty" => Some(Self::Bounty),
            "Vote" => Some(Self::Vote),
            "Factory Info Update" => Some(Self::FactoryInfoUpdate),
            "Unsupported" => Some(Self::Unsupported),
            _ => None,
        }
    }
}

