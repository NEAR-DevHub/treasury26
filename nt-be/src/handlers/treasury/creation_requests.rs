//! Persistence for treasury creation intent.
//!
//! Every creation attempt records its full request here before doing on-chain
//! work, and the row is **deleted on success** so the table only ever holds
//! unfinished creations. A row moves through three states:
//!
//! - `in_progress` — a creation is actively running (live request or sweeper).
//!   The sweeper leaves these alone until they go stale, so it never races an
//!   attempt that is still underway.
//! - `pending` — the attempt failed part-way. These are picked up quickly by
//!   the background sweeper (see [`super::creation_sweeper`]) and re-run.
//! - `failed` — gave up after too many sweep attempts (kept for review).
//!
//! Resuming from this stored request is the only way to finish a half-created
//! *confidential* DAO, since the intended member policy isn't recoverable from
//! chain.

use near_api::AccountId;
use sqlx::{PgPool, Row};

use super::create::CreateTreasuryRequest;

/// Give up sweeping a request after this many attempts and mark it `failed`.
pub const MAX_SWEEP_ATTEMPTS: i32 = 5;

/// A pending request claimed by the sweeper, with its attempt count.
pub struct SweepCandidate {
    pub request: CreateTreasuryRequest,
    pub attempts: i32,
}

/// Record (or refresh) the creation intent as `in_progress`. Called at the
/// start of every creation attempt (live or sweeper). While a row is
/// `in_progress` the sweeper won't touch it until it goes stale, so an active
/// attempt is never raced. A pre-existing row (e.g. a prior `pending`/`failed`
/// one being retried) is re-armed to `in_progress`. The attempt counter is
/// owned by the sweeper and intentionally left untouched here.
pub async fn record_creation_started(
    pool: &PgPool,
    req: &CreateTreasuryRequest,
) -> Result<(), sqlx::Error> {
    let governors: Vec<String> = req.governors.iter().map(|a| a.to_string()).collect();
    let financiers: Vec<String> = req.financiers.iter().map(|a| a.to_string()).collect();
    let requestors: Vec<String> = req.requestors.iter().map(|a| a.to_string()).collect();

    sqlx::query(
        r#"
        INSERT INTO incomplete_treasury_creations
            (account_id, name, payment_threshold, governance_threshold,
             governors, financiers, requestors, is_confidential, status, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress', NOW())
        ON CONFLICT (account_id) DO UPDATE SET
            name = EXCLUDED.name,
            payment_threshold = EXCLUDED.payment_threshold,
            governance_threshold = EXCLUDED.governance_threshold,
            governors = EXCLUDED.governors,
            financiers = EXCLUDED.financiers,
            requestors = EXCLUDED.requestors,
            is_confidential = EXCLUDED.is_confidential,
            status = 'in_progress',
            updated_at = NOW()
        "#,
    )
    .bind(req.account_id.as_str())
    .bind(&req.name)
    .bind(i16::from(req.payment_threshold))
    .bind(i16::from(req.governance_threshold))
    .bind(&governors)
    .bind(&financiers)
    .bind(&requestors)
    .bind(req.is_confidential)
    .execute(pool)
    .await?;

    Ok(())
}

/// Delete the request on successful completion, so the table only retains
/// in-flight (`pending`) and gave-up (`failed`) rows.
pub async fn delete_creation_request(pool: &PgPool, account_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM incomplete_treasury_creations WHERE account_id = $1")
        .bind(account_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Mark a part-way creation as `pending` (failed, resumable) and record the
/// latest error. This is what makes a row eligible for the sweeper to retry.
pub async fn mark_creation_pending(
    pool: &PgPool,
    account_id: &str,
    error: &str,
) -> Result<(), sqlx::Error> {
    let truncated: String = error.chars().take(1000).collect();
    sqlx::query(
        r#"
        UPDATE incomplete_treasury_creations
        SET status = 'pending', last_error = $2, updated_at = NOW()
        WHERE account_id = $1 AND status <> 'failed'
        "#,
    )
    .bind(account_id)
    .bind(truncated)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark a request `failed` (terminal) and record the error. Used both when a
/// request exhausts its sweep attempts and when it hits an unrecoverable error
/// (e.g. the handle is taken). Applies to any non-failed row so it works
/// straight from `in_progress` as well as `pending`.
pub async fn mark_creation_failed(
    pool: &PgPool,
    account_id: &str,
    error: &str,
) -> Result<(), sqlx::Error> {
    let truncated: String = error.chars().take(1000).collect();
    sqlx::query(
        r#"
        UPDATE incomplete_treasury_creations
        SET status = 'failed', last_error = $2, updated_at = NOW()
        WHERE account_id = $1 AND status <> 'failed'
        "#,
    )
    .bind(account_id)
    .bind(truncated)
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomically claim up to `limit` resumable requests, bumping their attempt
/// counter. `FOR UPDATE SKIP LOCKED` makes this safe across multiple replicas.
///
/// Two kinds of rows are eligible:
/// - `pending` (failed part-way): retried after a per-attempt backoff of
///   `LEAST(attempts * backoff_base_secs, backoff_cap_secs)`. A freshly-failed
///   row has `attempts = 0`, so it's picked up on the very next cycle.
/// - `in_progress` older than `stale_secs`: a live attempt that never finished
///   (e.g. the process crashed), reclaimed so it doesn't get stuck forever.
///
/// Rows at/above the attempt cap are never claimed.
pub async fn claim_stale_pending(
    pool: &PgPool,
    backoff_base_secs: i32,
    backoff_cap_secs: i32,
    stale_secs: i32,
    limit: i32,
) -> Result<Vec<SweepCandidate>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        UPDATE incomplete_treasury_creations
        SET attempts = attempts + 1, updated_at = NOW()
        WHERE account_id IN (
            SELECT account_id FROM incomplete_treasury_creations
            WHERE attempts < $1
              AND (
                    (status = 'pending'
                        AND updated_at < NOW() - make_interval(
                            secs => LEAST(attempts * $2, $3)))
                 OR (status = 'in_progress'
                        AND updated_at < NOW() - make_interval(secs => $4))
                  )
            ORDER BY updated_at ASC
            LIMIT $5
            FOR UPDATE SKIP LOCKED
        )
        RETURNING account_id, name, payment_threshold, governance_threshold,
                  governors, financiers, requestors, is_confidential, attempts
        "#,
    )
    .bind(MAX_SWEEP_ATTEMPTS)
    .bind(backoff_base_secs)
    .bind(backoff_cap_secs)
    .bind(stale_secs)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut candidates = Vec::with_capacity(rows.len());
    for row in rows {
        let account_id_str: String = row.try_get("account_id")?;
        let account_id = match account_id_str.parse::<AccountId>() {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!("Sweeper: skipping unparseable account_id {account_id_str}: {e}");
                continue;
            }
        };

        let governors = parse_account_ids(row.try_get::<Vec<String>, _>("governors")?);
        let financiers = parse_account_ids(row.try_get::<Vec<String>, _>("financiers")?);
        let requestors = parse_account_ids(row.try_get::<Vec<String>, _>("requestors")?);

        let payment_threshold: i16 = row.try_get("payment_threshold")?;
        let governance_threshold: i16 = row.try_get("governance_threshold")?;

        candidates.push(SweepCandidate {
            request: CreateTreasuryRequest {
                name: row.try_get("name")?,
                account_id,
                payment_threshold: payment_threshold as u8,
                governance_threshold: governance_threshold as u8,
                governors,
                financiers,
                requestors,
                is_confidential: row.try_get("is_confidential")?,
            },
            attempts: row.try_get("attempts")?,
        });
    }

    Ok(candidates)
}

fn parse_account_ids(raw: Vec<String>) -> Vec<AccountId> {
    raw.into_iter().filter_map(|s| s.parse().ok()).collect()
}
