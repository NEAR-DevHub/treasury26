//! Periodic status reconciler for `dao_proposals`.
//!
//! The linker only learns about a proposal when a NearBlocks receipt for it
//! flows through bronze ingest, and it resolves status via a live
//! `get_proposal` RPC at that moment. That leaves three gaps this sweep
//! exists to close:
//!
//! 1. **RPC outage at link time.** The linker deliberately writes no status
//!    when the fetch fails (a guessed status once regressed `approved` back
//!    to `in_progress`). The row stays `in_progress` until something
//!    re-reads it — that something is this sweep.
//! 2. **Terminal transitions with no receipt.** Proposals that finalize
//!    synchronously (policy changes) and proposals that expire without
//!    anyone calling `act_proposal(Finalize)` never produce an
//!    `on_proposal_callback` — no receipt means the linker is never
//!    triggered again, so only a periodic re-check can observe the
//!    transition.
//! 3. **Missed pages.** If a receipt page is permanently lost upstream
//!    (NearBlocks gap, exhausted backfill budget), the proposal row created
//!    by whichever receipts did arrive still converges to the correct
//!    terminal status here.
//!
//! Scope is intentionally narrow: status only (same monotonic rule as the
//! linker — only `in_progress` rows are ever touched), never execution
//! fields (`proposal_executed_at` etc. come exclusively from the
//! `on_proposal_callback` receipt). Claiming a batch pre-bumps `updated_at`
//! inside the claim statement itself, which both keeps concurrent replicas
//! off the same rows (`FOR UPDATE SKIP LOCKED`) and defers retry of failed
//! fetches to the next threshold without extra bookkeeping.

use chrono::{DateTime, Utc};
use near_api::AccountId;
use sqlx::PgPool;

use super::linker::proposal_status_as_str;
use crate::AppState;
use crate::handlers::proposals::scraper::fetch_proposal;
use crate::handlers::public_history::gold::cursors::mark_gold_dirty_tx;

const RECONCILE_BATCH_SIZE: i64 = 50;

#[derive(Debug, Clone, sqlx::FromRow)]
struct StaleProposal {
    dao_id: String,
    proposal_id: i64,
    proposal_created_at: Option<DateTime<Utc>>,
    proposal_executed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Default)]
pub struct ProposalReconcileStats {
    pub claimed: usize,
    pub updated: u64,
    pub fetch_failed: usize,
}

async fn claim_stale_proposals(pool: &PgPool) -> Result<Vec<StaleProposal>, sqlx::Error> {
    sqlx::query_as::<_, StaleProposal>(
        r#"
        UPDATE dao_proposals
        SET updated_at = NOW()
        WHERE (dao_id, proposal_id) IN (
            SELECT dao_id, proposal_id
            FROM dao_proposals
            WHERE status = 'in_progress'
              AND updated_at < NOW() - INTERVAL '10 minutes'
            ORDER BY updated_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING dao_id, proposal_id, proposal_created_at, proposal_executed_at
        "#,
    )
    .bind(RECONCILE_BATCH_SIZE)
    .fetch_all(pool)
    .await
}

async fn apply_status(
    pool: &PgPool,
    proposal: &StaleProposal,
    status: &'static str,
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        r#"
        UPDATE dao_proposals
        SET status = $3::proposal_status,
            updated_at = NOW()
        WHERE dao_id = $1
          AND proposal_id = $2
          AND status = 'in_progress'
        "#,
    )
    .bind(&proposal.dao_id)
    .bind(proposal.proposal_id)
    .bind(status)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if updated > 0 {
        // Silver legs already carry proposal_ref; status is joined fresh from
        // dao_proposals at gold projection time, so a status-only change needs
        // only a gold re-projection.
        let recompute_from = match (proposal.proposal_created_at, proposal.proposal_executed_at) {
            (Some(created), Some(executed)) => Some(created.min(executed)),
            (Some(created), None) => Some(created),
            (None, Some(executed)) => Some(executed),
            (None, None) => None,
        };
        mark_gold_dirty_tx(&mut tx, &proposal.dao_id, recompute_from).await?;
    }

    tx.commit().await?;
    Ok(updated)
}

pub async fn reconcile_stale_proposals(
    state: &AppState,
) -> Result<ProposalReconcileStats, sqlx::Error> {
    let claimed = claim_stale_proposals(&state.db_pool).await?;
    let mut stats = ProposalReconcileStats {
        claimed: claimed.len(),
        ..ProposalReconcileStats::default()
    };

    for proposal in &claimed {
        let Ok(account_id) = proposal.dao_id.parse::<AccountId>() else {
            continue;
        };
        let Ok(rpc_proposal_id) = u64::try_from(proposal.proposal_id) else {
            continue;
        };
        match fetch_proposal(&state.network, &account_id, rpc_proposal_id).await {
            Ok(fetched) => {
                let status = proposal_status_as_str(&fetched.status);
                if status == "in_progress" {
                    continue;
                }
                stats.updated += apply_status(&state.db_pool, proposal, status).await?;
            }
            Err(error) => {
                // Transient RPC failures and deleted (removed) proposals are
                // indistinguishable here, so no status is inferred; the claim
                // already bumped updated_at, deferring retry a full threshold.
                stats.fetch_failed += 1;
                tracing::warn!(
                    dao_id = proposal.dao_id,
                    proposal_id = proposal.proposal_id,
                    error = ?error,
                    "proposal reconciler fetch failed"
                );
            }
        }
    }

    Ok(stats)
}
