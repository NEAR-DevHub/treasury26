use near_api::types::ft::FungibleTokenMetadata;
use near_api::{AccountId, Contract, FTBalance, NetworkConfig};
use serde::Deserialize;

use crate::constants::intents_tokens::find_token_by_symbol;
use crate::handlers::proposals::scraper::{
    AssetExchangeInfo, LockupInfo, PaymentInfo, Policy, Proposal, ProposalType,
    StakeDelegationInfo, Vote, fetch_ft_metadata, get_status_display,
};
use crate::utils::cache::{Cache, CacheKey, CacheTier};

use std::collections::HashSet;

// Helper function to parse date string "2024-09-10" to timestamp
fn parse_date_to_timestamp(date_str: &str, is_to: bool) -> Result<u64, Box<dyn std::error::Error>> {
    use chrono::{NaiveDate, TimeZone, Utc};

    // Trim whitespace and newlines
    let date_str = date_str.trim();
    let date = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")?;
    let datetime = if is_to {
        date.and_hms_opt(23, 59, 59).unwrap()
    } else {
        date.and_hms_opt(0, 0, 0).unwrap()
    };
    let utc_datetime = Utc.from_utc_datetime(&datetime);

    // Convert to nanoseconds (same format as proposal timestamps)
    Ok(utc_datetime.timestamp_nanos_opt().unwrap_or(0) as u64)
}

// Helper function to determine the source of a proposal
fn get_proposal_source(proposal: &Proposal) -> &'static str {
    // Check if it's a NEAR Intents proposal
    if let Some(function_call) = proposal.kind.get("FunctionCall") {
        let receiver_id = function_call
            .get("receiver_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if receiver_id == "intents.near" {
            return "intents";
        }

        // Check if it's a lockup proposal (any interaction with lockup.near contracts)
        if receiver_id.contains("lockup.near") {
            return "lockup";
        }
    }

    // Default to sputnikdao for all other proposals
    "sputnikdao"
}

#[derive(Deserialize, Clone)]
pub enum SortBy {
    CreationTime,
    ExpiryTime,
}

#[derive(Deserialize, Default, Clone)]
pub struct ProposalFilters {
    pub statuses: Option<String>, // comma-separated values like "Approved,Rejected"
    pub search: Option<String>,   // search the description
    pub search_not: Option<String>, // exclude proposals containing these keywords
    pub proposal_types: Option<String>, // comma-separated values like 'FunctionCall,Transfer'
    pub sort_by: Option<SortBy>,
    pub sort_direction: Option<String>, // "asc" or "desc"
    pub created_date_from: Option<String>,
    pub created_date_to: Option<String>,
    pub created_date_from_not: Option<String>, // exclude proposals created from this date
    pub created_date_to_not: Option<String>,   // exclude proposals created until this date

    pub amount_min: Option<String>,
    pub amount_max: Option<String>,
    pub amount_equal: Option<String>,

    pub proposers: Option<String>,     // comma-separated accounts
    pub proposers_not: Option<String>, // comma-separated accounts

    pub approvers: Option<String>,     // comma-separated accounts
    pub approvers_not: Option<String>, // array of accounts
    pub voter_votes: Option<String>, // format: "account:vote,account:vote" where vote is "approved", "rejected", or "no_voted"

    // Source filter
    pub source: Option<String>, // comma-separated values like "sputnikdao,intents,lockup"
    pub source_not: Option<String>, // comma-separated values to exclude like "sputnikdao,intents,lockup"

    // Payment-specific filters
    pub recipients: Option<String>,     // comma-separated accounts
    pub recipients_not: Option<String>, // comma-separated accounts
    pub tokens: Option<String>,         // comma-separated ft token ids
    pub tokens_not: Option<String>,     // comma-separated ft token ids

    // Stake delegation specific filters
    pub stake_type: Option<String>, // comma-separated values like "stake,unstake,withdraw"
    pub stake_type_not: Option<String>, // comma-separated values to exclude like "stake,unstake,withdraw"
    pub validators: Option<String>,     // comma-separated validator accounts
    pub validators_not: Option<String>, // comma-separated validator accounts to exclude
    // Pagination
    pub page: Option<usize>,
    pub page_size: Option<usize>,
}

fn to_str_hashset(opt: &Option<String>) -> Option<HashSet<&str>> {
    opt.as_ref()
        .map(|s| s.split(',').map(|s| s.trim()).collect())
}

#[derive(Debug, Clone)]
struct VoterVote {
    account: String,
    expected_vote: Vec<String>,
}

fn parse_voter_votes(opt: &Option<String>) -> Option<Vec<VoterVote>> {
    opt.as_ref().map(|s| {
        s.split(',')
            .filter_map(|pair| {
                let parts: Vec<&str> = pair.trim().split(':').collect();
                if parts.len() == 2 {
                    Some(VoterVote {
                        account: parts[0].trim().to_string(),
                        expected_vote: parts[1]
                            .trim()
                            .split(',')
                            .map(|s| s.trim().to_string())
                            .collect(),
                    })
                } else {
                    None
                }
            })
            .collect()
    })
}

fn get_token_addresses(symbol: &str) -> Option<Vec<String>> {
    find_token_by_symbol(&symbol.to_lowercase()).map(|token| {
        token
            .grouped_tokens
            .into_iter()
            .map(|token| token.defuse_asset_id)
            .map(|token| {
                token
                    .split(':')
                    .nth(1)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| token)
            })
            .collect()
    })
}

/// Check if a token matches against the tokens filter sets
fn token_matches_filter(
    token_to_check: &str,
    tokens_set: &Option<HashSet<&str>>,
    tokens_not_set: &Option<HashSet<&str>>,
) -> bool {
    if let Some(tokens) = tokens_set {
        for token in tokens {
            let token_addresses = get_token_addresses(token);
            if let Some(token_addresses) = token_addresses
                && token_addresses.iter().any(|t| t == token_to_check)
            {
                return true;
            }
        }
        return false;
    }

    if let Some(tokens_not) = tokens_not_set {
        for token in tokens_not {
            let token_addresses = get_token_addresses(token);
            if let Some(token_addresses) = token_addresses
                && token_addresses.iter().any(|t| t == token_to_check)
            {
                return false;
            }
        }
    }

    true // Token matched the filter
}

// Smart filter helper functions

/// Check if proposal matches tokens filter (applies to payments, stake delegation, lockup)
fn matches_tokens_filter(
    proposal: &Proposal,
    tokens_set: &Option<HashSet<&str>>,
    tokens_not_set: &Option<HashSet<&str>>,
) -> bool {
    // Check payments
    if let Some(payment_info) = PaymentInfo::from_proposal(proposal) {
        let token_to_check = if payment_info.token.is_empty() {
            "wrap.near"
        } else {
            payment_info.token.as_str()
        };

        return token_matches_filter(token_to_check, tokens_set, tokens_not_set);
    }

    if StakeDelegationInfo::from_proposal(proposal).is_some() {
        let token_to_check = "wrap.near"; // Stake delegation is usually NEAR
        return token_matches_filter(token_to_check, tokens_set, tokens_not_set);
    }

    if LockupInfo::from_proposal(proposal).is_some() {
        let token_to_check = "wrap.near"; // Lockup is typically NEAR
        return token_matches_filter(token_to_check, tokens_set, tokens_not_set);
    }

    if let Some(asset_exchange_info) = AssetExchangeInfo::from_proposal(proposal) {
        let token_in = asset_exchange_info
            .token_in_address
            .as_str()
            .split(':')
            .nth(1)
            .unwrap_or(&asset_exchange_info.token_in_address);
        if token_matches_filter(token_in, tokens_set, tokens_not_set) {
            return true;
        }

        if let Some(tokens) = tokens_set
            && tokens.contains(&asset_exchange_info.token_out_symbol.as_str())
        {
            return true;
        }
        if let Some(tokens_not) = tokens_not_set
            && tokens_not.contains(&asset_exchange_info.token_out_symbol.as_str())
        {
            return false;
        }
        return true;
    }

    tokens_set.is_none() && tokens_not_set.is_none()
}

/// Check if proposal matches recipients filter (applies to payments)
fn matches_recipients_filter(
    proposal: &Proposal,
    recipients_set: &Option<HashSet<&str>>,
    recipients_not_set: &Option<HashSet<&str>>,
) -> bool {
    // Check payments
    if let Some(payment_info) = PaymentInfo::from_proposal(proposal) {
        if let Some(recipients) = recipients_set
            && !recipients.contains(payment_info.receiver.as_str())
        {
            return false;
        }
        if let Some(recipients_not) = recipients_not_set
            && recipients_not.contains(payment_info.receiver.as_str())
        {
            return false;
        }
        return true; // Payment proposal matched recipients filter
    }

    if let Some(asset_exchange_info) = AssetExchangeInfo::from_proposal(proposal) {
        if let Some(recipients) = recipients_set
            && !recipients.contains(
                asset_exchange_info
                    .deposit_address
                    .as_ref()
                    .unwrap_or(&"".to_string())
                    .as_str(),
            )
        {
            return false;
        }
        if let Some(recipients_not) = recipients_not_set
            && recipients_not.contains(
                asset_exchange_info
                    .deposit_address
                    .as_ref()
                    .unwrap_or(&"".to_string())
                    .as_str(),
            )
        {
            return false;
        }
        return true;
    }

    if let Some(stake_info) = StakeDelegationInfo::from_proposal(proposal) {
        if let Some(recipients) = recipients_set
            && !recipients.contains(stake_info.validator.as_str())
        {
            return false;
        }
        if let Some(recipients_not) = recipients_not_set
            && recipients_not.contains(stake_info.validator.as_str())
        {
            return false;
        }
        return true;
    }

    if let Some(lockup_info) = LockupInfo::from_proposal(proposal) {
        if let Some(recipients) = recipients_set
            && !recipients.contains(lockup_info.receiver.as_str())
        {
            return false;
        }
        if let Some(recipients_not) = recipients_not_set
            && recipients_not.contains(lockup_info.receiver.as_str())
        {
            return false;
        }
        return true;
    }

    // If no relevant proposal type found and recipients filter is specified, exclude
    recipients_set.is_none() && recipients_not_set.is_none()
}

/// Check if proposal matches validators filter (applies to stake delegation)
async fn matches_validators_filter(
    proposal: &Proposal,
    validators_set: &Option<HashSet<&str>>,
    validators_not_set: &Option<HashSet<&str>>,
    cache: &Cache,
    network: &NetworkConfig,
) -> bool {
    if let Some(stake_info) = StakeDelegationInfo::from_proposal(proposal) {
        // For lockup proposals, we need to get the validator from RPC if not already set
        let mut validator_to_check = stake_info.validator.clone();
        if stake_info.validator.as_str().contains("lockup.near")
            && stake_info.proposal_type != "whitelist"
        {
            // This is a lockup proposal that's not a select_staking_pool call
            // We need to get the validator from the lockup contract
            let cache_key = CacheKey::new("pool-lookup")
                .with(&stake_info.validator)
                .build();
            let pool_id = cache
                .cached_contract_call(CacheTier::LongTerm, cache_key, async move {
                    Ok(Contract(stake_info.validator.clone())
                        .call_function("get_staking_pool_account_id", ())
                        .read_only::<Option<AccountId>>()
                        .fetch_from(network)
                        .await?
                        .data)
                })
                .await
                .unwrap_or_default();
            if let Some(pool_id) = pool_id {
                validator_to_check = pool_id;
            }
        }

        if let Some(validators) = validators_set
            && !validators.contains(validator_to_check.as_str())
        {
            return false;
        }
        if let Some(validators_not) = validators_not_set
            && validators_not.contains(validator_to_check.as_str())
        {
            return false;
        }
        return true; // Stake delegation proposal matched validators filter
    }

    // If no stake delegation proposal found and validators filter is specified, exclude
    validators_set.is_none() && validators_not_set.is_none()
}

/// Check if proposal matches stake_type filter (applies to stake delegation)
fn matches_stake_type_filter(
    proposal: &Proposal,
    stake_type_set: &Option<HashSet<&str>>,
    stake_type_not_set: &Option<HashSet<&str>>,
) -> bool {
    if let Some(stake_info) = StakeDelegationInfo::from_proposal(proposal) {
        if let Some(stake_types) = stake_type_set
            && !stake_types.contains(stake_info.proposal_type.as_str())
        {
            return false;
        }
        if let Some(stake_types_not) = stake_type_not_set
            && stake_types_not.contains(stake_info.proposal_type.as_str())
        {
            return false;
        }
        return true; // Stake delegation proposal matched stake_type filter
    }

    // If no stake delegation proposal found and stake_type filter is specified, exclude
    stake_type_set.is_none() && stake_type_not_set.is_none()
}

/// Check if proposal matches amount filters (applies to payments, stake delegation)
async fn matches_amount_filters(
    proposal: &Proposal,
    filters: &ProposalFilters,
    cache: &Cache,
    network: &NetworkConfig,
) -> bool {
    if filters.amount_equal.is_none()
        && filters.amount_min.is_none()
        && filters.amount_max.is_none()
    {
        return true; // No amount filters specified
    }

    // Check payments
    if let Some(payment_info) = PaymentInfo::from_proposal(proposal) {
        return matches_payment_amount_filters(&payment_info, filters, cache, network).await;
    }

    // Check stake delegation
    if let Some(stake_info) = StakeDelegationInfo::from_proposal(proposal) {
        return matches_stake_amount_filters(&stake_info, filters);
    }

    // Check asset exchange
    if let Some(asset_exchange_info) = AssetExchangeInfo::from_proposal(proposal) {
        return matches_payment_amount_filters(
            &PaymentInfo {
                receiver: asset_exchange_info
                    .deposit_address
                    .unwrap_or("".to_string()),
                token: asset_exchange_info
                    .token_in_address
                    .as_str()
                    .split(':')
                    .nth(1)
                    .unwrap_or(&asset_exchange_info.token_in_address)
                    .to_string(),
                amount: asset_exchange_info.amount_in.to_string(),
                is_lockup: false,
            },
            filters,
            cache,
            network,
        )
        .await;
    }

    // Check lockup
    if let Some(lockup_info) = LockupInfo::from_proposal(proposal) {
        return matches_payment_amount_filters(
            &PaymentInfo {
                receiver: lockup_info.receiver.to_string(),
                token: "".to_string(),
                amount: lockup_info.amount,
                is_lockup: true,
            },
            filters,
            cache,
            network,
        )
        .await;
    }

    // If no relevant proposal type found and amount filters are specified, exclude
    false
}

async fn matches_payment_amount_filters(
    payment_info: &PaymentInfo,
    filters: &ProposalFilters,
    cache: &Cache,
    network: &NetworkConfig,
) -> bool {
    // Get token metadata for amount comparison
    let token_id = if payment_info.token.is_empty() {
        "near"
    } else {
        &payment_info.token
    };

    let cache_key = CacheKey::new("ft-metadata-filters").with(token_id).build();
    let ft_metadata = cache
        .cached_contract_call(CacheTier::LongTerm, cache_key, async move {
            if token_id == "near" {
                return Ok(FungibleTokenMetadata {
                    decimals: 24,
                    name: "Near".to_string(),
                    symbol: "NEAR".to_string(),
                    icon: None,
                    reference: None,
                    reference_hash: None,
                    spec: "".to_string(),
                });
            }
            fetch_ft_metadata(network, &token_id.parse::<AccountId>().unwrap()).await
        })
        .await
        .unwrap_or_else(|_| FungibleTokenMetadata {
            decimals: 0,
            name: "".to_string(),
            symbol: "".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            spec: "".to_string(),
        });
    let token_decimals = ft_metadata.decimals;

    let proposal_amount = payment_info.amount.parse::<u128>().ok();

    if let Some(amount_equal_str) = &filters.amount_equal {
        if let Ok(amount_equal) =
            FTBalance::with_decimals(token_decimals).with_float_str(amount_equal_str)
        {
            if let Some(amount) = proposal_amount {
                if amount != amount_equal.amount() {
                    return false;
                }
            } else {
                return false; // Invalid amount
            }
        } else {
            return false; // Invalid amount_equal input
        }
    }

    if let Some(min_str) = &filters.amount_min {
        if let Ok(min) = FTBalance::with_decimals(token_decimals).with_float_str(min_str) {
            if let Some(amount) = proposal_amount {
                if amount < min.amount() {
                    return false;
                }
            } else {
                return false; // Invalid amount
            }
        } else {
            return false; // Invalid amount_min input
        }
    }

    if let Some(max_str) = &filters.amount_max {
        if let Ok(max) = FTBalance::with_decimals(token_decimals).with_float_str(max_str) {
            if let Some(amount) = proposal_amount {
                if amount > max.amount() {
                    return false;
                }
            } else {
                return false; // Invalid amount
            }
        } else {
            return false; // Invalid amount_max input
        }
    }

    true
}

fn matches_stake_amount_filters(
    stake_info: &StakeDelegationInfo,
    filters: &ProposalFilters,
) -> bool {
    let stake_amount = stake_info.amount.parse::<u128>().ok();

    if let Some(amount_equal_str) = &filters.amount_equal {
        if let Ok(amount_equal) = FTBalance::with_decimals(24).with_float_str(amount_equal_str) {
            if let Some(amount) = stake_amount {
                if amount != amount_equal.amount() {
                    return false;
                }
            } else {
                return false; // Invalid amount
            }
        } else {
            return false; // Invalid amount_equal input
        }
    }

    if let Some(min_str) = &filters.amount_min {
        if let Ok(min) = FTBalance::with_decimals(24).with_float_str(min_str) {
            if let Some(amount) = stake_amount {
                if amount < min.amount() {
                    return false;
                }
            } else {
                return false; // Invalid amount
            }
        } else {
            return false; // Invalid min input
        }
    }

    if let Some(max_str) = &filters.amount_max {
        if let Ok(max) = FTBalance::with_decimals(24).with_float_str(max_str) {
            if let Some(amount) = stake_amount {
                if amount > max.amount() {
                    return false;
                }
            } else {
                return false; // Invalid amount
            }
        } else {
            return false; // Invalid max input
        }
    }

    true
}

impl ProposalFilters {
    pub async fn filter_proposals_async(
        &self,
        proposals: Vec<Proposal>,
        policy: &Policy,
        cache: &Cache,
        network: &NetworkConfig,
    ) -> Result<Vec<Proposal>, Box<dyn std::error::Error>> {
        let statuses_set = to_str_hashset(&self.statuses);
        let proposers_set = to_str_hashset(&self.proposers);
        let proposers_not_set = to_str_hashset(&self.proposers_not);
        let approvers_set = to_str_hashset(&self.approvers);
        let approvers_not_set = to_str_hashset(&self.approvers_not);
        let voter_votes_set = parse_voter_votes(&self.voter_votes);
        let recipients_set = to_str_hashset(&self.recipients);
        let recipients_not_set = to_str_hashset(&self.recipients_not);
        let tokens_set = to_str_hashset(&self.tokens);
        let tokens_not_set = to_str_hashset(&self.tokens_not);
        let proposal_types_set = to_str_hashset(&self.proposal_types);
        let stake_type_set = to_str_hashset(&self.stake_type);
        let stake_type_not_set = to_str_hashset(&self.stake_type_not);
        let validators_set = to_str_hashset(&self.validators);
        let validators_not_set = to_str_hashset(&self.validators_not);
        let source_set = to_str_hashset(&self.source);
        let source_not_set = to_str_hashset(&self.source_not);

        let search_keywords: Option<Vec<String>> = self.search.as_ref().map(|s| {
            s.split(',')
                .map(|k| k.trim().to_lowercase())
                .filter(|k| !k.is_empty())
                .collect()
        });

        let search_not_keywords: Option<Vec<String>> = self.search_not.as_ref().map(|s| {
            s.split(',')
                .map(|k| k.trim().to_lowercase())
                .filter(|k| !k.is_empty())
                .collect()
        });

        let from_timestamp = self
            .created_date_from
            .as_ref()
            .and_then(|d| parse_date_to_timestamp(d, false).ok());
        let to_timestamp = self
            .created_date_to
            .as_ref()
            .and_then(|d| parse_date_to_timestamp(d, true).ok());
        let from_timestamp_not = self
            .created_date_from_not
            .as_ref()
            .and_then(|d| parse_date_to_timestamp(d, false).ok());
        let to_timestamp_not = self
            .created_date_to_not
            .as_ref()
            .and_then(|d| parse_date_to_timestamp(d, true).ok());

        let mut filtered_proposals = Vec::with_capacity(proposals.len());

        for proposal in proposals {
            let submission_time = proposal.submission_time.0;

            if let Some(ref proposers) = proposers_set
                && !proposers.contains(proposal.proposer.as_str())
            {
                continue;
            }

            if let Some(ref proposers_not) = proposers_not_set
                && proposers_not.contains(proposal.proposer.as_str())
            {
                continue;
            }

            if let Some(ref approvers) = approvers_set {
                let has_any_approver = approvers
                    .iter()
                    .any(|approver| proposal.votes.contains_key(*approver));
                if !has_any_approver {
                    continue;
                }
            }

            if let Some(ref approvers_not) = approvers_not_set {
                let has_any_excluded_approver = approvers_not
                    .iter()
                    .any(|approver| proposal.votes.contains_key(*approver));
                if has_any_excluded_approver {
                    continue;
                }
            }

            if let Some(from_ts) = from_timestamp
                && submission_time < from_ts
            {
                continue;
            }
            if let Some(to_ts) = to_timestamp
                && submission_time > to_ts
            {
                continue;
            }

            // NOT date filters - exclude proposals within this range
            if let Some(from_ts_not) = from_timestamp_not {
                if let Some(to_ts_not) = to_timestamp_not {
                    // Both NOT filters specified - exclude if within range
                    if submission_time >= from_ts_not && submission_time <= to_ts_not {
                        continue;
                    }
                } else {
                    // Only from_not specified - exclude if on or after this date
                    if submission_time >= from_ts_not {
                        continue;
                    }
                }
            } else if let Some(to_ts_not) = to_timestamp_not {
                // Only to_not specified - exclude if on or before this date
                if submission_time <= to_ts_not {
                    continue;
                }
            }

            if let Some(ref statuses) = statuses_set {
                let computed_status = get_status_display(
                    &proposal.status,
                    submission_time,
                    policy.proposal_period.0,
                    "InProgress",
                );
                if !statuses.contains(computed_status.as_str()) {
                    continue;
                }
            }

            if let Some(ref keywords) = search_keywords {
                let proposal_id_str = proposal.id.to_string();
                let description_lower = proposal.description.to_lowercase();
                let proposal_id_lower = proposal_id_str.to_lowercase();

                if !keywords.iter().any(|kw| {
                    // If keyword is only numbers, search for exact proposal ID match
                    if kw.chars().all(|c| c.is_ascii_digit()) {
                        proposal_id_str == *kw
                    } else {
                        description_lower.contains(kw) || proposal_id_lower.contains(kw)
                    }
                }) {
                    continue;
                }
            }

            if let Some(ref keywords_not) = search_not_keywords {
                let proposal_id_str = proposal.id.to_string();
                let description_lower = proposal.description.to_lowercase();
                let proposal_id_lower = proposal_id_str.to_lowercase();

                if keywords_not.iter().any(|kw| {
                    // If keyword is only numbers, search for exact proposal ID match
                    if kw.chars().all(|c| c.is_ascii_digit()) {
                        proposal_id_str == *kw
                    } else {
                        description_lower.contains(kw) || proposal_id_lower.contains(kw)
                    }
                }) {
                    continue;
                }
            }

            if let Some(ref proposal_types) = proposal_types_set {
                let proposal_kind_keys: Vec<&str> = if let Some(obj) = proposal.kind.as_object() {
                    obj.keys().map(|k| k.as_str()).collect()
                } else {
                    Vec::new()
                };

                if !proposal_types
                    .iter()
                    .any(|proposal_type| proposal_kind_keys.contains(proposal_type))
                {
                    continue;
                }
            }

            if let Some(ref voter_votes) = voter_votes_set {
                let mut all_voter_checks_passed = true;
                for voter_vote in voter_votes {
                    let actual_vote = proposal.votes.get(&voter_vote.account);
                    let vote_status = match actual_vote {
                        Some(Vote::Approve) => "Approved",
                        Some(Vote::Reject) | Some(Vote::Remove) => "Rejected",
                        None => "No Voted",
                    };

                    if !voter_vote.expected_vote.iter().any(|v| v == vote_status) {
                        all_voter_checks_passed = false;
                        break;
                    }
                }

                if !all_voter_checks_passed {
                    continue;
                }
            }

            // Filter by source
            if let Some(ref sources) = source_set {
                let proposal_source = get_proposal_source(&proposal);
                if !sources.contains(proposal_source) {
                    continue;
                }
            }

            // Filter by source (exclusion)
            if let Some(ref sources_not) = source_not_set {
                let proposal_source = get_proposal_source(&proposal);
                if sources_not.contains(proposal_source) {
                    continue;
                }
            }

            // Smart filters - apply each filter independently across relevant proposal types

            // Apply tokens filter
            if !matches_tokens_filter(&proposal, &tokens_set, &tokens_not_set) {
                continue;
            }

            // Apply recipients filter
            if !matches_recipients_filter(&proposal, &recipients_set, &recipients_not_set) {
                continue;
            }

            // Apply validators filter
            if !matches_validators_filter(
                &proposal,
                &validators_set,
                &validators_not_set,
                cache,
                network,
            )
            .await
            {
                continue;
            }

            // Apply stake_type filter
            if !matches_stake_type_filter(&proposal, &stake_type_set, &stake_type_not_set) {
                continue;
            }

            // Apply amount filters
            if !matches_amount_filters(&proposal, self, cache, network).await {
                continue;
            }

            filtered_proposals.push(proposal);
        }

        // Sort the proposals based on the sort_by and sort_direction parameters
        if let Some(sort_criteria) = &self.sort_by {
            let is_ascending = self
                .sort_direction
                .as_deref()
                .map(|d| d.to_lowercase() == "asc")
                .unwrap_or(true);

            match sort_criteria {
                SortBy::CreationTime => filtered_proposals.sort_by(|a, b| {
                    let ordering = a.submission_time.0.cmp(&b.submission_time.0);
                    if is_ascending {
                        ordering
                    } else {
                        ordering.reverse()
                    }
                }),
                SortBy::ExpiryTime => filtered_proposals.sort_by(|a, b| {
                    let ordering = (a.submission_time.0 + policy.proposal_period.0)
                        .cmp(&(b.submission_time.0 + policy.proposal_period.0));
                    if is_ascending {
                        ordering
                    } else {
                        ordering.reverse()
                    }
                }),
            }
        }

        Ok(filtered_proposals)
    }

    pub fn filter_and_extract<T: ProposalType>(
        &self,
        proposals: Vec<Proposal>,
    ) -> Vec<(Proposal, T)> {
        proposals
            .into_iter()
            .filter_map(|proposal| T::from_proposal(&proposal).map(|info| (proposal, info)))
            .collect()
    }
}
