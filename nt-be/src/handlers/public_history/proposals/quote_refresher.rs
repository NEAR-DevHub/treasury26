use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use crate::AppState;
use crate::handlers::intents::swap_status::fetch_public_swap_status;
use crate::handlers::public_history::quotes::{
    QuoteProposalType, merge_quote_status, proposal_quote_from_metadata, quote_status_is_failed,
    quote_status_is_terminal, quote_status_text_from_metadata, quote_status_value_from_metadata,
};
use crate::handlers::public_history::silver::cursors::mark_silver_dirty_tx;

const QUOTE_REFRESH_BATCH_SIZE: i64 = 50;

#[derive(Debug, Clone, sqlx::FromRow)]
struct StaleQuoteProposal {
    dao_id: String,
    proposal_id: i64,
    quote_deposit_address: String,
    quote_metadata: Option<Value>,
    proposal_created_at: Option<DateTime<Utc>>,
    proposal_executed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Default)]
pub struct QuoteRefreshStats {
    pub claimed: usize,
    pub updated: u64,
    pub fetch_failed: usize,
}

async fn claim_stale_quote_proposals(
    pool: &PgPool,
) -> Result<Vec<StaleQuoteProposal>, sqlx::Error> {
    sqlx::query_as::<_, StaleQuoteProposal>(
        r#"
        UPDATE dao_proposals
        SET quote_status_checked_at = NOW()
        WHERE id IN (
            SELECT id
            FROM dao_proposals
            WHERE quote_deposit_address IS NOT NULL
              AND COALESCE(proposal_executed_at, proposal_created_at) > NOW() - INTERVAL '30 days'
              AND (
                  quote_status_checked_at IS NULL
                  OR quote_status_checked_at < NOW() - INTERVAL '2 minutes'
              )
              AND (
                  quote_metadata IS NULL
                  OR COALESCE(
                      UPPER(quote_metadata->'status'->>'status'),
                      UPPER(quote_metadata->>'status')
                  ) IS NULL
                  OR COALESCE(
                      UPPER(quote_metadata->'status'->>'status'),
                      UPPER(quote_metadata->>'status')
                  ) NOT IN ('SUCCESS', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT')
              )
            ORDER BY COALESCE(proposal_executed_at, proposal_created_at) DESC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING
            dao_id,
            proposal_id,
            quote_deposit_address,
            quote_metadata,
            proposal_created_at,
            proposal_executed_at
        "#,
    )
    .bind(QUOTE_REFRESH_BATCH_SIZE)
    .fetch_all(pool)
    .await
}

/// Returns the merged metadata when a new status was written (`None` when the
/// write was skipped), so the caller can see terminal-failure transitions.
async fn apply_quote_status(
    tx: &mut Transaction<'_, Postgres>,
    proposal: &StaleQuoteProposal,
    status: Value,
) -> Result<Option<Value>, sqlx::Error> {
    // The claim lock is released before the 1Click fetch, so the linker may
    // have merged newer metadata meanwhile; reload under lock and merge
    // against the current value, never regressing a terminal status.
    let current: Option<Value> = sqlx::query_scalar(
        r#"
        SELECT quote_metadata
        FROM dao_proposals
        WHERE dao_id = $1
          AND proposal_id = $2
        FOR UPDATE
        "#,
    )
    .bind(&proposal.dao_id)
    .bind(proposal.proposal_id)
    .fetch_optional(&mut **tx)
    .await?
    .flatten();

    if quote_status_is_terminal(current.as_ref()) {
        return Ok(None);
    }
    if quote_status_value_from_metadata(current.as_ref()) == Some(&status) {
        return Ok(None);
    }

    let merged = merge_quote_status(current.as_ref(), status);
    let updated = sqlx::query(
        r#"
        UPDATE dao_proposals
        SET quote_metadata = $3,
            quote_status_checked_at = NOW(),
            updated_at = NOW()
        WHERE dao_id = $1
          AND proposal_id = $2
        "#,
    )
    .bind(&proposal.dao_id)
    .bind(proposal.proposal_id)
    .bind(&merged)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    if updated > 0 {
        mark_silver_dirty_tx(
            tx,
            &proposal.dao_id,
            proposal
                .proposal_executed_at
                .or(proposal.proposal_created_at),
        )
        .await?;
        return Ok(Some(merged));
    }

    Ok(None)
}

/// Report the transition into a terminal failed 1Click status — a user's
/// exchange or cross-chain payment permanently failing. Edge-triggered:
/// `apply_quote_status` never rewrites a terminal status, so this fires
/// exactly once per proposal. Routed to Telegram by a Sentry alert rule on
/// `priority:p1`.
fn report_terminal_failure(proposal: &StaleQuoteProposal, merged: &Value) {
    if !quote_status_is_failed(Some(merged)) {
        return;
    }

    let (error_code, label) = match proposal_quote_from_metadata(Some(merged)).map(|q| q.quote_type)
    {
        Some(QuoteProposalType::PaymentTransfer) => ("PAYMENT_TERMINAL_FAILED", "payment"),
        _ => ("EXCHANGE_TERMINAL_FAILED", "exchange"),
    };
    let status_text =
        quote_status_text_from_metadata(Some(merged)).unwrap_or_else(|| "failed".to_string());

    tracing::error!(
        tags.error_code = error_code,
        tags.priority = "p1",
        dao_id = proposal.dao_id,
        proposal_id = proposal.proposal_id,
        deposit_address = proposal.quote_deposit_address,
        status = status_text,
        "1Click {label} reached terminal failed status"
    );
}

pub async fn refresh_public_quote_statuses(
    state: &AppState,
) -> Result<QuoteRefreshStats, sqlx::Error> {
    let proposals = claim_stale_quote_proposals(&state.db_pool).await?;
    let mut stats = QuoteRefreshStats {
        claimed: proposals.len(),
        ..QuoteRefreshStats::default()
    };

    for proposal in proposals {
        if quote_status_is_terminal(proposal.quote_metadata.as_ref()) {
            continue;
        }
        match fetch_public_swap_status(
            &state.http_client,
            &state.env_vars.oneclick_api_url,
            state.env_vars.oneclick_jwt_token.as_ref(),
            &proposal.quote_deposit_address,
            None,
        )
        .await
        {
            Ok(response) => {
                if let Ok(status) = serde_json::to_value(response) {
                    let mut tx = state.db_pool.begin().await?;
                    let merged = apply_quote_status(&mut tx, &proposal, status).await?;
                    tx.commit().await?;
                    if let Some(merged) = merged {
                        stats.updated += 1;
                        report_terminal_failure(&proposal, &merged);
                    }
                }
            }
            Err((status, reason)) => {
                stats.fetch_failed += 1;
                tracing::warn!(
                    dao_id = proposal.dao_id,
                    proposal_id = proposal.proposal_id,
                    deposit_address = proposal.quote_deposit_address,
                    status = %status,
                    reason = %reason,
                    "failed to refresh public quote status"
                );
            }
        }
    }

    Ok(stats)
}
