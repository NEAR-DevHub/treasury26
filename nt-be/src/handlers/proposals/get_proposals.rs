use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use futures::future::join_all;
use serde::Deserialize;
use std::sync::Arc;

use super::types::{Proposal, ProposalResponse, ProposalUIKind};
use super::utils::get_proposal_ui_kind;
use crate::AppState;

#[derive(Deserialize, Debug, Clone)]
pub struct ProposalsQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    pub statuses: Option<String>,
    pub proposal_types: Option<String>,
    pub proposers: Option<String>,
    pub proposers_not: Option<String>,
    pub approvers: Option<String>,
    pub approvers_not: Option<String>,
    pub recipients: Option<String>,
    pub recipients_not: Option<String>,
    pub tokens: Option<String>,
    pub tokens_not: Option<String>,
    pub amount_min: Option<String>,
    pub amount_max: Option<String>,
    pub amount_equal: Option<String>,
    pub stake_type: Option<String>,
    pub stake_type_not: Option<String>,
    pub validators: Option<String>,
    pub validators_not: Option<String>,
    pub source: Option<String>,
    pub source_not: Option<String>,
    pub search: Option<String>,
    pub search_not: Option<String>,
    pub created_date_from: Option<String>,
    pub created_date_to: Option<String>,
    pub sort_by: Option<String>,
    pub sort_direction: Option<String>,
}

async fn fetch_all_proposals(
    state: &AppState,
    dao_id: &str,
    sputnik_query: &str,
) -> Result<Vec<Proposal>, (StatusCode, String)> {
    let base_url = format!(
        "{}/proposals/{}",
        state.env_vars.sputnik_dao_api_base, dao_id
    );
    let page_size = 50; // Use a reasonable page size for bulk fetching

    let first_url = if sputnik_query.is_empty() {
        format!("{}?page=0&page_size={}", base_url, page_size)
    } else {
        format!(
            "{}?{}&page=0&page_size={}",
            base_url, sputnik_query, page_size
        )
    };

    let response = state
        .http_client
        .get(&first_url)
        .send()
        .await
        .map_err(|e| {
            log::error!("Error fetching first page of proposals: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch proposals: {}", e),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        log::error!("Sputnik DAO API error: {} - {}", status, error_text);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Sputnik DAO API error: {}", error_text),
        ));
    }

    let body = response.bytes().await.map_err(|e| {
        log::error!("Error reading response body: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to read response".to_string(),
        )
    })?;

    let first_page: serde_json::Value = serde_json::from_slice(&body).map_err(|e| {
        log::error!(
            "Error parsing first page as JSON: {}. Body preview: {}",
            e,
            String::from_utf8_lossy(&body)
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse proposals".to_string(),
        )
    })?;

    let proposals_val = first_page.get("proposals").and_then(|v| v.as_array());
    let total = first_page
        .get("total")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let page = first_page.get("page").and_then(|v| v.as_u64()).unwrap_or(0);
    let page_size = first_page
        .get("page_size")
        .and_then(|v| v.as_u64())
        .unwrap_or(50);

    let mut all_proposals = Vec::new();
    if let Some(arr) = proposals_val {
        for v in arr {
            if let Ok(proposal) = serde_json::from_value::<Proposal>(v.clone()) {
                all_proposals.push(proposal);
            } else {
                log::error!("Failed to parse proposal from first page: {}", v);
            }
        }
    }

    if total > page_size as u64 {
        let num_pages = total.div_ceil(page_size as u64);
        let mut futures = Vec::new();

        for p in 1..num_pages {
            let url = if sputnik_query.is_empty() {
                format!("{}?page={}&page_size={}", base_url, p, page_size)
            } else {
                format!(
                    "{}?{}&page={}&page_size={}",
                    base_url, sputnik_query, p, page_size
                )
            };
            futures.push(state.http_client.get(url).send());
        }

        let results = join_all(futures).await;
        for resp in results.into_iter().flatten() {
            if resp.status().is_success() {
                if let Ok(page_data) = resp.json::<serde_json::Value>().await {
                    if let Some(arr) = page_data.get("proposals").and_then(|v| v.as_array()) {
                        for v in arr {
                            if let Ok(proposal) = serde_json::from_value::<Proposal>(v.clone()) {
                                all_proposals.push(proposal);
                            } else {
                                log::error!("Failed to parse proposal from subsequent page: {}", v);
                            }
                        }
                    }
                }
            }
        }
    }

    // Categorize all proposals
    for proposal in &mut all_proposals {
        proposal.custom_kind = Some(get_proposal_ui_kind(proposal));
    }

    Ok(all_proposals)
}

pub async fn get_proposals(
    State(state): State<Arc<AppState>>,
    Path(dao_id): Path<String>,
    Query(query): Query<ProposalsQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if dao_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "dao_id is required".to_string()));
    }

    // Build Sputnik-compatible query string for initial filtering
    let mut sputnik_params = Vec::new();
    if let Some(statuses) = &query.statuses {
        sputnik_params.push(format!("statuses={}", statuses));
    }
    if let Some(proposers) = &query.proposers {
        sputnik_params.push(format!("proposers={}", proposers));
    }
    if let Some(proposers_not) = &query.proposers_not {
        sputnik_params.push(format!("proposers_not={}", proposers_not));
    }
    if let Some(approvers) = &query.approvers {
        sputnik_params.push(format!("approvers={}", approvers));
    }
    if let Some(approvers_not) = &query.approvers_not {
        sputnik_params.push(format!("approvers_not={}", approvers_not));
    }
    if let Some(recipients) = &query.recipients {
        sputnik_params.push(format!("recipients={}", recipients));
    }
    if let Some(recipients_not) = &query.recipients_not {
        sputnik_params.push(format!("recipients_not={}", recipients_not));
    }
    if let Some(tokens) = &query.tokens {
        sputnik_params.push(format!("tokens={}", tokens));
    }
    if let Some(tokens_not) = &query.tokens_not {
        sputnik_params.push(format!("tokens_not={}", tokens_not));
    }
    if let Some(amount_min) = &query.amount_min {
        sputnik_params.push(format!("amount_min={}", amount_min));
    }
    if let Some(amount_max) = &query.amount_max {
        sputnik_params.push(format!("amount_max={}", amount_max));
    }
    if let Some(amount_equal) = &query.amount_equal {
        sputnik_params.push(format!("amount_equal={}", amount_equal));
    }
    if let Some(stake_type) = &query.stake_type {
        sputnik_params.push(format!("stake_type={}", stake_type));
    }
    if let Some(stake_type_not) = &query.stake_type_not {
        sputnik_params.push(format!("stake_type_not={}", stake_type_not));
    }
    if let Some(validators) = &query.validators {
        sputnik_params.push(format!("validators={}", validators));
    }
    if let Some(validators_not) = &query.validators_not {
        sputnik_params.push(format!("validators_not={}", validators_not));
    }
    if let Some(source) = &query.source {
        sputnik_params.push(format!("source={}", source));
    }
    if let Some(source_not) = &query.source_not {
        sputnik_params.push(format!("source_not={}", source_not));
    }
    if let Some(search) = &query.search {
        sputnik_params.push(format!("search={}", search));
    }
    if let Some(search_not) = &query.search_not {
        sputnik_params.push(format!("search_not={}", search_not));
    }
    if let Some(created_date_from) = &query.created_date_from {
        sputnik_params.push(format!("created_date_from={}", created_date_from));
    }
    if let Some(created_date_to) = &query.created_date_to {
        sputnik_params.push(format!("created_date_to={}", created_date_to));
    }

    let sputnik_query_str = sputnik_params.join("&");
    let cache_key = format!("proposals:all:{}:{}", dao_id, sputnik_query_str);

    let mut all_proposals = if let Some(cached) = state.cache.get(&cache_key).await {
        serde_json::from_value(cached).unwrap_or_default()
    } else {
        let fetched = fetch_all_proposals(&state, &dao_id, &sputnik_query_str).await?;
        state
            .cache
            .insert(
                cache_key,
                serde_json::to_value(&fetched).unwrap_or_default(),
            )
            .await;
        fetched
    };

    // Apply custom type filtering
    let requested_types: Vec<ProposalUIKind> = query
        .proposal_types
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter_map(|s| ProposalUIKind::from_str(s.trim()))
        .collect();

    if !requested_types.is_empty() {
        all_proposals.retain(|p| {
            if let Some(kind) = &p.custom_kind {
                requested_types.contains(kind)
            } else {
                false
            }
        });
    }

    // Apply sorting
    let sort_by = query.sort_by.as_deref().unwrap_or("CreationTime");
    let sort_direction = query.sort_direction.as_deref().unwrap_or("desc");

    all_proposals.sort_by(|a, b| {
        let res = match sort_by {
            "CreationTime" => {
                let a_time = a.submission_time.parse::<u128>().unwrap_or(0);
                let b_time = b.submission_time.parse::<u128>().unwrap_or(0);
                a_time.cmp(&b_time)
            }
            "ExpiryTime" => {
                // Expiry time depends on policy, which we don't have here easily.
                // For now, fall back to submission time.
                let a_time = a.submission_time.parse::<u128>().unwrap_or(0);
                let b_time = b.submission_time.parse::<u128>().unwrap_or(0);
                a_time.cmp(&b_time)
            }
            _ => a.id.cmp(&b.id),
        };
        if sort_direction == "desc" {
            res.reverse()
        } else {
            res
        }
    });

    let total = all_proposals.len() as u64;
    let page = query.page.unwrap_or(0);
    let page_size = query.page_size.unwrap_or(20);

    let start = (page * page_size) as usize;
    let end = std::cmp::min(start + page_size as usize, all_proposals.len());

    let paginated_proposals = if start < all_proposals.len() {
        all_proposals[start..end].to_vec()
    } else {
        Vec::new()
    };

    let response = ProposalResponse {
        page,
        page_size,
        total,
        proposals: paginated_proposals,
    };

    Ok((StatusCode::OK, Json(response)))
}

pub async fn get_proposal(
    State(state): State<Arc<AppState>>,
    Path((dao_id, proposal_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if dao_id.is_empty() || proposal_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "proposal_id is required".to_string(),
        ));
    }

    let response = state
        .http_client
        .get(format!(
            "{}/proposal/{}/{}",
            state.env_vars.sputnik_dao_api_base, dao_id, proposal_id
        ))
        .send()
        .await
        .map_err(|e| {
            log::error!("Error fetching proposal from Sputnik DAO API: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch proposal: {}", e),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        log::error!("Sputnik DAO API error: {} - {}", status, error_text);
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            format!("Sputnik DAO API error: {}", error_text),
        ));
    }

    let body = response.bytes().await.map_err(|e| {
        log::error!("Error reading proposal response body: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to read response".to_string(),
        )
    })?;

    let mut proposal: Proposal = serde_json::from_slice(&body).map_err(|e| {
        log::error!(
            "Error parsing proposal: {}. Body: {}",
            e,
            String::from_utf8_lossy(&body)
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to parse proposal: {}", e),
        )
    })?;

    proposal.custom_kind = Some(get_proposal_ui_kind(&proposal));

    Ok((StatusCode::OK, Json(proposal)))
}
