use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use near_api::AccountId;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

use crate::handlers::proposals::{
    filters::{ProposalFilters, SortBy},
    scraper::{
        Policy, Proposal, extract_from_description, extract_payload_hash_from_kind, fetch_policy,
        fetch_proposal, fetch_proposals,
    },
};
use crate::{
    AppState,
    auth::OptionalAuthUser,
    utils::cache::{CacheKey, CacheTier},
};
use sqlx::PgPool;

#[derive(Deserialize)]
pub struct GetProposalsQuery {
    pub types: Option<String>,
    pub types_not: Option<String>,
    pub statuses: Option<String>,
    pub search: Option<String>,
    pub search_not: Option<String>,
    pub proposal_types: Option<String>,
    pub sort_by: Option<String>,
    pub sort_direction: Option<String>,
    pub category: Option<String>,
    pub created_date_from: Option<String>,
    pub created_date_to: Option<String>,
    pub created_date_from_not: Option<String>,
    pub created_date_to_not: Option<String>,
    pub amount_min: Option<String>,
    pub amount_max: Option<String>,
    pub amount_equal: Option<String>,
    pub proposers: Option<String>,
    pub proposers_not: Option<String>,
    pub approvers: Option<String>,
    pub approvers_not: Option<String>,
    pub voter_votes: Option<String>,
    pub source: Option<String>,
    pub source_not: Option<String>,
    pub recipients: Option<String>,
    pub recipients_not: Option<String>,
    pub token: Option<String>,
    pub token_not: Option<String>,
    pub stake_type: Option<String>,
    pub stake_type_not: Option<String>,
    pub validators: Option<String>,
    pub validators_not: Option<String>,
    pub page: Option<usize>,
    pub page_size: Option<usize>,
}

#[derive(serde::Serialize)]
pub struct PaginatedProposals {
    pub proposals: Vec<Proposal>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(sqlx::FromRow)]
struct ConfidentialProposalMetadataRow {
    payload_hash: String,
    quote_metadata: Option<serde_json::Value>,
    status: String,
    correlation_id: Option<String>,
    notes: Option<String>,
    proposal_created_at: Option<chrono::DateTime<chrono::Utc>>,
    proposal_executed_at: Option<chrono::DateTime<chrono::Utc>>,
    gold_amount_in_usd: Option<String>,
    gold_amount_out_usd: Option<String>,
    gold_usd_change: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PublicProposalMetadataRow {
    proposal_id: i64,
    proposal_created_at: Option<chrono::DateTime<chrono::Utc>>,
    proposal_executed_at: Option<chrono::DateTime<chrono::Utc>>,
    amount_in_usd: Option<String>,
    amount_out_usd: Option<String>,
    usd_change: Option<String>,
    transaction_type: String,
}

pub async fn get_proposals(
    State(state): State<Arc<AppState>>,
    auth_user: OptionalAuthUser,
    Path(dao_id): Path<AccountId>,
    Query(query): Query<GetProposalsQuery>,
) -> Result<(StatusCode, Json<PaginatedProposals>), (StatusCode, String)> {
    // Create cache key for proposals
    let cache_key = CacheKey::new("dao-proposals").with(&dao_id).build();

    // Try to get from cache first
    let (proposals, policy): (Vec<Proposal>, Policy) = state
        .cache
        .cached_contract_call(CacheTier::ShortTerm, cache_key, async {
            let proposals = fetch_proposals(&state.network, &dao_id).await?;

            let policy = fetch_policy(&state.network, &dao_id).await?;

            Ok((proposals, policy))
        })
        .await?;

    // Create filters from query params
    let filters = ProposalFilters {
        statuses: query.statuses,
        search: query.search,
        search_not: query.search_not,
        proposal_types: query.proposal_types,
        sort_by: query.sort_by.and_then(|s| match s.as_str() {
            "CreationTime" => Some(SortBy::CreationTime),
            "ExpiryTime" => Some(SortBy::ExpiryTime),
            _ => None,
        }),
        types: query.types,
        types_not: query.types_not,
        sort_direction: query.sort_direction,
        created_date_from: query.created_date_from,
        created_date_to: query.created_date_to,
        created_date_from_not: query.created_date_from_not,
        created_date_to_not: query.created_date_to_not,
        amount_min: query.amount_min,
        amount_max: query.amount_max,
        amount_equal: query.amount_equal,
        proposers: query.proposers,
        proposers_not: query.proposers_not,
        approvers: query.approvers,
        approvers_not: query.approvers_not,
        voter_votes: query.voter_votes,
        source: query.source,
        source_not: query.source_not,
        recipients: query.recipients,
        recipients_not: query.recipients_not,
        token: query.token,
        token_not: query.token_not,
        stake_type: query.stake_type,
        stake_type_not: query.stake_type_not,
        validators: query.validators,
        validators_not: query.validators_not,
        page: query.page,
        page_size: query.page_size,
    };

    // Enrich confidential proposals BEFORE filtering so filters can see subtype.
    // Only enrich if the caller is an authenticated DAO member.
    let confidentiality_check = auth_user
        .verify_member_if_confidential(&state.db_pool, dao_id.as_ref())
        .await;
    let mut proposals = proposals;
    if matches!(confidentiality_check, Ok(true)) {
        enrich_confidential_proposals(&mut proposals, &state.db_pool, dao_id.as_ref()).await;
    }

    // Apply filters
    let filtered_proposals = filters
        .filter_proposals_async(
            proposals,
            &policy,
            &state.cache,
            &state.network,
            &state.bulk_payment_contract_id,
            dao_id.as_ref(),
        )
        .await
        .map_err(|e| {
            tracing::warn!("Error filtering proposals: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to filter proposals".to_string(),
            )
        })?;

    let total = filtered_proposals.len();

    // Handle pagination
    let mut proposals = match (query.page, query.page_size) {
        (Some(page), Some(page_size)) => {
            let start = page * page_size;
            let end = start + page_size;

            if start < total {
                filtered_proposals[start..total.min(end)].to_vec()
            } else {
                vec![]
            }
        }
        _ => filtered_proposals,
    };

    if matches!(confidentiality_check, Ok(false)) {
        enrich_public_proposals(&mut proposals, &state.db_pool, dao_id.as_ref()).await;
    }

    let response = PaginatedProposals {
        proposals,
        total,
        page: query.page.unwrap_or(0),
        page_size: query.page_size.unwrap_or(total),
    };

    Ok((StatusCode::OK, Json(response)))
}

pub async fn get_proposal(
    State(state): State<Arc<AppState>>,
    auth_user: OptionalAuthUser,
    Path((dao_id, proposal_id)): Path<(AccountId, u64)>,
) -> Result<(StatusCode, Json<Proposal>), (StatusCode, String)> {
    // Create cache key for specific proposal
    let cache_key = CacheKey::new("dao-proposal")
        .with(&dao_id)
        .with(proposal_id)
        .build();

    // Try to get from cache first
    let mut proposal: Proposal = state
        .cache
        .cached_contract_call(CacheTier::ShortTerm, cache_key, async {
            fetch_proposal(&state.network, &dao_id, proposal_id).await
        })
        .await?;

    // Enrich if confidential — only for authenticated DAO members
    let confidentiality_check = auth_user
        .verify_member_if_confidential(&state.db_pool, dao_id.as_ref())
        .await;
    if matches!(confidentiality_check, Ok(true)) {
        enrich_confidential_proposals(
            std::slice::from_mut(&mut proposal),
            &state.db_pool,
            dao_id.as_ref(),
        )
        .await;
    } else if matches!(confidentiality_check, Ok(false)) {
        enrich_public_proposals(
            std::slice::from_mut(&mut proposal),
            &state.db_pool,
            dao_id.as_ref(),
        )
        .await;
    }

    Ok((StatusCode::OK, Json(proposal)))
}

#[derive(serde::Serialize)]
pub struct ProposersResponse {
    pub proposers: Vec<String>,
    pub total: usize,
}

pub async fn get_dao_proposers(
    State(state): State<Arc<AppState>>,
    Path(dao_id): Path<AccountId>,
) -> Result<(StatusCode, Json<ProposersResponse>), (StatusCode, String)> {
    // Create cache key for proposals
    let cache_key = CacheKey::new("dao-proposals").with(&dao_id).build();

    // Get cached proposals
    let (proposals, _policy): (Vec<Proposal>, Policy) = state
        .cache
        .cached_contract_call(CacheTier::ShortTerm, cache_key, async {
            let proposals = fetch_proposals(&state.network, &dao_id).await?;

            let policy = fetch_policy(&state.network, &dao_id).await?;

            Ok((proposals, policy))
        })
        .await?;

    // Extract unique proposers from all proposals
    let mut proposers: std::collections::HashSet<String> = std::collections::HashSet::new();
    for proposal in &proposals {
        proposers.insert(proposal.proposer.clone());
    }

    let mut proposers_vec: Vec<String> = proposers.into_iter().collect();
    proposers_vec.sort_unstable(); // Sort alphabetically for consistent ordering

    let total = proposers_vec.len();

    let response = ProposersResponse {
        proposers: proposers_vec,
        total,
    };

    Ok((StatusCode::OK, Json(response)))
}

#[derive(serde::Serialize)]
pub struct ApproversResponse {
    pub approvers: Vec<String>,
    pub total: usize,
}

pub async fn get_dao_approvers(
    State(state): State<Arc<AppState>>,
    Path(dao_id): Path<AccountId>,
) -> Result<(StatusCode, Json<ApproversResponse>), (StatusCode, String)> {
    // Create cache key for proposals
    let cache_key = CacheKey::new("dao-proposals").with(&dao_id).build();

    // Get cached proposals
    let (proposals, _policy): (Vec<Proposal>, Policy) = state
        .cache
        .cached_contract_call(CacheTier::ShortTerm, cache_key, async {
            let proposals = fetch_proposals(&state.network, &dao_id).await?;

            let policy = fetch_policy(&state.network, &dao_id).await?;

            Ok((proposals, policy))
        })
        .await?;

    // Extract unique approvers from all proposals
    let mut approvers: std::collections::HashSet<String> = std::collections::HashSet::new();
    for proposal in &proposals {
        // Add all voters from the votes HashMap
        for voter in proposal.votes.keys() {
            approvers.insert(voter.clone());
        }
    }

    let mut approvers_vec: Vec<String> = approvers.into_iter().collect();
    approvers_vec.sort_unstable(); // Sort alphabetically for consistent ordering

    let total = approvers_vec.len();

    let response = ApproversResponse {
        approvers: approvers_vec,
        total,
    };

    Ok((StatusCode::OK, Json(response)))
}

/// Enrich confidential proposals (v1.signer) with quote_metadata, status, and
/// correlation_id from the `confidential_intents` table.
/// Operates in-place on the proposals slice; non-confidential proposals are untouched.
async fn enrich_confidential_proposals(proposals: &mut [Proposal], pool: &PgPool, dao_id: &str) {
    // Collect (index, payload_hash) pairs for all confidential proposals
    let hash_indices: Vec<(usize, String)> = proposals
        .iter()
        .enumerate()
        .filter_map(|(i, p)| extract_payload_hash_from_kind(&p.kind).map(|hash| (i, hash)))
        .collect();

    if hash_indices.is_empty() {
        return;
    }

    let hashes: Vec<&str> = hash_indices.iter().map(|(_, h)| h.as_str()).collect();

    // Batch query all matching intents
    let rows = sqlx::query_as::<_, ConfidentialProposalMetadataRow>(
        r#"
        SELECT
            ci.payload_hash,
            ci.quote_metadata,
            ci.status,
            ci.correlation_id,
            ci.notes,
            ci.proposal_created_at,
            ci.proposal_executed_at,
            gold.amount_in_usd::TEXT AS gold_amount_in_usd,
            gold.amount_out_usd::TEXT AS gold_amount_out_usd,
            gold.usd_change::TEXT AS gold_usd_change
        FROM confidential_intents ci
        LEFT JOIN LATERAL (
            SELECT amount_in_usd, amount_out_usd, usd_change
            FROM gold_confidential_history_events
            WHERE intent_id = ci.id
            ORDER BY COALESCE(proposal_executed_at, quote_created_at) DESC, id DESC
            LIMIT 1
        ) gold ON TRUE
        WHERE ci.dao_id = $1 AND ci.payload_hash = ANY($2)
        "#,
    )
    .bind(dao_id)
    .bind(&hashes)
    .fetch_all(pool)
    .await;

    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("Failed to fetch confidential intent metadata: {}", e);
            return;
        }
    };

    // Build lookup map: payload_hash → metadata
    let metadata_map: std::collections::HashMap<&str, serde_json::Value> = rows
        .iter()
        .map(|row| {
            (
                row.payload_hash.as_str(),
                serde_json::json!({
                    "quote_metadata": row.quote_metadata,
                    "status": row.status,
                    "correlation_id": row.correlation_id,
                    "notes": row.notes,
                    "proposal_created_at": row.proposal_created_at,
                    "proposal_executed_at": row.proposal_executed_at,
                    "gold_metadata": {
                        "amount_in_usd": row.gold_amount_in_usd,
                        "amount_out_usd": row.gold_amount_out_usd,
                        "usd_change": row.gold_usd_change,
                    },
                }),
            )
        })
        .collect();

    // Attach single-intent metadata to proposals
    for (idx, hash) in &hash_indices {
        if let Some(metadata) = metadata_map.get(hash.as_str()) {
            proposals[*idx].confidential_metadata = Some(metadata.clone());
        }
    }

    // ── Bulk-payment overlay ────────────────────────────────────────────
    // Pre-filter: only proposals whose description carries a `payload_hashes`
    // field can possibly be bulk headers. Skip the DB hop entirely if none.
    let bulk_candidate_hashes: Vec<&str> = hash_indices
        .iter()
        .filter_map(|(idx, hash)| {
            extract_from_description(&proposals[*idx].description, "Payload Hashes")
                .map(|_| hash.as_str())
        })
        .collect();

    if bulk_candidate_hashes.is_empty() {
        return;
    }

    // For any of these hashes that are bulk *headers*, fetch the linked
    // recipient intents and attach a `bulk` field beside the existing
    // single-intent metadata. Two batched queries — no N+1.
    let bulk_rows = sqlx::query_as::<_, (
        String,         // header_payload_hash
        String,         // bulk_account_id (sub)
        Vec<String>,    // recipient_payload_hashes
        String,         // status
        Option<i64>,    // proposal_id
    )>(
        "SELECT header_payload_hash, bulk_account_id, recipient_payload_hashes, status, proposal_id \
         FROM confidential_bulk_payments \
         WHERE dao_id = $1 AND header_payload_hash = ANY($2)",
    )
    .bind(dao_id)
    .bind(&bulk_candidate_hashes)
    .fetch_all(pool)
    .await;

    let bulk_rows = match bulk_rows {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("Failed to fetch bulk-payment metadata: {}", e);
            return;
        }
    };

    if bulk_rows.is_empty() {
        return;
    }

    // Flatten all recipient hashes for one batched lookup, paired with the
    // sub_id (used as `dao_id` for recipient rows in `confidential_intents`).
    let mut recipient_keys: Vec<(String, String)> = Vec::new(); // (sub_id, hash)
    for (_, sub_id, recipients, _, _) in &bulk_rows {
        for h in recipients {
            recipient_keys.push((sub_id.clone(), h.clone()));
        }
    }
    // Hash alone is unique enough — `confidential_intents.payload_hash` is
    // a NEP-413 SHA-256, no collisions across DAOs in practice. Skipping
    // the dao_id filter avoids the per-sub fan-out.
    let recipient_hashes_flat: Vec<&str> = recipient_keys.iter().map(|(_, h)| h.as_str()).collect();

    let recipient_rows = sqlx::query_as::<
        _,
        (
            String,                    // dao_id
            String,                    // payload_hash
            Option<serde_json::Value>, // quote_metadata
            String,                    // status
            Option<serde_json::Value>, // submit_result
        ),
    >(
        "SELECT dao_id, payload_hash, quote_metadata, status, submit_result \
         FROM confidential_intents \
         WHERE payload_hash = ANY($1)",
    )
    .bind(&recipient_hashes_flat)
    .fetch_all(pool)
    .await;

    let recipient_rows = match recipient_rows {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("Failed to fetch bulk recipient intents: {}", e);
            return;
        }
    };

    // hash → recipient summary
    let recipient_map: std::collections::HashMap<&str, serde_json::Value> = recipient_rows
        .iter()
        .map(|(_sub, hash, quote_meta, status, submit_result)| {
            (
                hash.as_str(),
                serde_json::json!({
                    "payload_hash": hash,
                    "quote_metadata": quote_meta,
                    "status": status,
                    "submit_result": submit_result,
                }),
            )
        })
        .collect();

    // header_hash → bulk overlay JSON
    let bulk_map: std::collections::HashMap<&str, serde_json::Value> = bulk_rows
        .iter()
        .map(|(header_hash, sub_id, recipients, status, proposal_id)| {
            let recipients_json: Vec<serde_json::Value> = recipients
                .iter()
                .map(|h| {
                    recipient_map.get(h.as_str()).cloned().unwrap_or_else(|| {
                        serde_json::json!({
                            "payload_hash": h,
                            "quote_metadata": null,
                            "status": "missing",
                            "submit_result": null,
                        })
                    })
                })
                .collect();
            (
                header_hash.as_str(),
                serde_json::json!({
                    "status": status,
                    "bulk_account_id": sub_id,
                    "proposal_id": proposal_id,
                    "recipients": recipients_json,
                }),
            )
        })
        .collect();

    // Merge bulk overlay into the per-proposal confidential_metadata.
    for (idx, hash) in &hash_indices {
        if let Some(bulk) = bulk_map.get(hash.as_str()) {
            let existing = proposals[*idx]
                .confidential_metadata
                .clone()
                .unwrap_or_else(|| serde_json::json!({}));
            let mut merged = existing;
            if let serde_json::Value::Object(ref mut map) = merged {
                map.insert("bulk".into(), bulk.clone());
            }
            proposals[*idx].confidential_metadata = Some(merged);
        }
    }
}

/// Enrich public payment/exchange proposals with historical dates and USD
/// values from public gold history. This is display-only metadata, so list
/// responses call it after filtering/pagination to avoid querying unseen rows.
async fn enrich_public_proposals(proposals: &mut [Proposal], pool: &PgPool, dao_id: &str) {
    let proposal_indices: Vec<(usize, i64)> = proposals
        .iter()
        .enumerate()
        .filter_map(|(index, proposal)| {
            i64::try_from(proposal.id)
                .ok()
                .map(|proposal_id| (index, proposal_id))
        })
        .collect();

    if proposal_indices.is_empty() {
        return;
    }

    let proposal_ids: Vec<i64> = proposal_indices
        .iter()
        .map(|(_, proposal_id)| *proposal_id)
        .collect();

    let rows = sqlx::query_as::<_, PublicProposalMetadataRow>(
        r#"
        SELECT DISTINCT ON (proposal_id)
            proposal_id,
            proposal_created_at,
            proposal_executed_at,
            amount_in_usd::TEXT,
            amount_out_usd::TEXT,
            usd_change::TEXT,
            transaction_type::TEXT AS transaction_type
        FROM gold_public_history_events
        WHERE dao_id = $1
          AND proposal_id = ANY($2::BIGINT[])
          AND transaction_type IN ('sent', 'exchange')
        ORDER BY proposal_id, COALESCE(proposal_executed_at, proposal_created_at, event_time) DESC, id DESC
        "#,
    )
    .bind(dao_id)
    .bind(&proposal_ids)
    .fetch_all(pool)
    .await;

    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!("Failed to fetch public proposal metadata: {}", error);
            return;
        }
    };

    let metadata_map: HashMap<i64, serde_json::Value> = rows
        .iter()
        .map(|row| {
            (
                row.proposal_id,
                serde_json::json!({
                    "proposal_created_at": row.proposal_created_at,
                    "proposal_executed_at": row.proposal_executed_at,
                    "gold_metadata": {
                        "amount_in_usd": row.amount_in_usd,
                        "amount_out_usd": row.amount_out_usd,
                        "usd_change": row.usd_change,
                        "transaction_type": row.transaction_type,
                    },
                }),
            )
        })
        .collect();

    for (index, proposal_id) in proposal_indices {
        if let Some(metadata) = metadata_map.get(&proposal_id) {
            proposals[index].public_metadata = Some(metadata.clone());
        }
    }
}
