//! Read-side adapter that lets `/api/balance-changes`, `/api/recent-activity`,
//! and `/api/balance-history/export` serve confidential DAOs from
//! `gold_confidential_history_events` while keeping the response shape
//! (`EnrichedBalanceChange`) identical to the public list.
//!
//! Exchange Gold rows surface as a single Exchange Fulfillment row (the
//! request side is intentionally hidden for confidential DAOs).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bigdecimal::{BigDecimal, FromPrimitive, Zero};
use chrono::{DateTime, Utc};
use near_api::AccountId;
use sqlx::{PgPool, QueryBuilder, Row};

use crate::AppState;
use crate::handlers::intents::confidential::types::{ConfidentialTxType, bare_account};
use crate::handlers::token::{TokenMetadata, fetch_tokens_with_fallback};
use crate::routes::{BalanceChangesQuery, EnrichedBalanceChange, SwapInfo};

/// Normalize client account filters to bare form for exact SQL match against gold.
fn normalize_account_filter_values(accounts: &[String]) -> Vec<String> {
    accounts
        .iter()
        .map(|account| bare_account(account))
        .collect()
}

#[derive(Debug)]
struct ConfidentialBalanceChangeRow {
    id: i64,
    history_event_id: i64,
    dao_id: AccountId,
    transaction_type: ConfidentialTxType,
    origin_asset: Option<String>,
    destination_asset: String,
    amount_in: Option<BigDecimal>,
    amount_out: BigDecimal,
    amount_in_usd: Option<BigDecimal>,
    amount_out_usd: Option<BigDecimal>,
    origin_balance_before: Option<BigDecimal>,
    origin_balance_after: Option<BigDecimal>,
    destination_balance_before: Option<BigDecimal>,
    destination_balance_after: Option<BigDecimal>,
    recipient: String,
    counterparty: String,
    proposal_execution_block_height: Option<i64>,
    proposal_executed_at: Option<DateTime<Utc>>,
    proposal_execution_transaction_hash: Option<String>,
    quote_created_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    proposal_id: Option<i64>,
    /// On-chain deposit tx hash from quoteTransactions[0].txHash.
    deposit_tx_hash: Option<String>,
}

impl sqlx::FromRow<'_, sqlx::postgres::PgRow> for ConfidentialBalanceChangeRow {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        let dao_id: String = row.try_get("dao_id")?;
        let dao_id = dao_id
            .parse::<AccountId>()
            .map_err(|e| sqlx::Error::Decode(Box::new(e)))?;

        Ok(Self {
            id: row.try_get("id")?,
            history_event_id: row.try_get("history_event_id")?,
            dao_id,
            transaction_type: row.try_get("transaction_type")?,
            origin_asset: row.try_get("origin_asset")?,
            destination_asset: row.try_get("destination_asset")?,
            amount_in: row.try_get("amount_in")?,
            amount_out: row.try_get("amount_out")?,
            amount_in_usd: row.try_get("amount_in_usd")?,
            amount_out_usd: row.try_get("amount_out_usd")?,
            origin_balance_before: row.try_get("origin_balance_before")?,
            origin_balance_after: row.try_get("origin_balance_after")?,
            destination_balance_before: row.try_get("destination_balance_before")?,
            destination_balance_after: row.try_get("destination_balance_after")?,
            recipient: row.try_get("recipient")?,
            counterparty: row.try_get("counterparty")?,
            proposal_execution_block_height: row.try_get("proposal_execution_block_height")?,
            proposal_executed_at: row.try_get("proposal_executed_at")?,
            proposal_execution_transaction_hash: row
                .try_get("proposal_execution_transaction_hash")?,
            quote_created_at: row.try_get("quote_created_at")?,
            created_at: row.try_get("created_at")?,
            proposal_id: row.try_get("proposal_id")?,
            deposit_tx_hash: row.try_get("deposit_tx_hash")?,
        })
    }
}

/// `true` if `dao_id` is flagged as a confidential treasury in `monitored_accounts`.
pub async fn is_confidential_dao(pool: &PgPool, dao_id: &str) -> Result<bool, sqlx::Error> {
    let flag: Option<Option<bool>> = sqlx::query_scalar(
        r#"
        SELECT is_confidential_account
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(dao_id)
    .fetch_optional(pool)
    .await?;

    Ok(flag.flatten().unwrap_or(false))
}

pub async fn fetch_balance_change_legs(
    state: &Arc<AppState>,
    params: &BalanceChangesQuery,
) -> Result<Vec<EnrichedBalanceChange>, Box<dyn std::error::Error + Send + Sync>> {
    let dao_id = params.account_id.as_str().to_string();

    let start_date = params
        .start_time
        .as_ref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc));
    let end_date = params
        .end_time
        .as_ref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc));

    let directional_types = match params
        .transaction_types
        .as_ref()
        .map(|types| classify_direction_filter(types))
    {
        Some(DirectionFilter::Empty) => return Ok(Vec::new()),
        Some(DirectionFilter::Types(types)) => Some(types),
        None => None,
    };

    let min_amount = params.min_amount.and_then(BigDecimal::from_f64);
    let max_amount = params.max_amount.and_then(BigDecimal::from_f64);

    let from_allow = params
        .from_accounts
        .as_ref()
        .filter(|t| !t.is_empty())
        .map(|t| normalize_account_filter_values(t));
    let from_deny = params
        .from_accounts_not
        .as_ref()
        .filter(|t| !t.is_empty())
        .map(|t| normalize_account_filter_values(t));
    let to_allow = params
        .to_accounts
        .as_ref()
        .filter(|t| !t.is_empty())
        .map(|t| normalize_account_filter_values(t));
    let to_deny = params
        .to_accounts_not
        .as_ref()
        .filter(|t| !t.is_empty())
        .map(|t| normalize_account_filter_values(t));

    // Apply token / account / amount / date filters in SQL *before* pagination
    // so a small limit can't drop legs that would otherwise match the filter
    // (the old in-Rust filter ran post-limit). Date sort/filter uses
    // event_time (proposal_executed_at → quote_created_at) rather than
    // gold_confidential_history_events.created_at, which is the projection insert
    // time and would surface old transactions as today's activity. Amount
    // bounds compare against the formatted decimal amount directly — gold
    // already stores amountOutFormatted, not raw token units.
    let mut builder = QueryBuilder::<sqlx::Postgres>::new(
        r#"
        WITH legs AS (
            SELECT
                id, history_event_id, dao_id, transaction_type,
                origin_asset, destination_asset,
                amount_in, amount_out, amount_in_usd, amount_out_usd,
                origin_balance_before, origin_balance_after,
                destination_balance_before, destination_balance_after,
                recipient, counterparty,
                proposal_execution_block_height,
                proposal_executed_at,
                proposal_execution_transaction_hash,
                quote_created_at, created_at,
                deposit_tx_hash,
                (
                    SELECT ci.proposal_id
                    FROM confidential_intents ci
                    WHERE ci.id = gold_confidential_history_events.intent_id
                ) AS proposal_id,
                COALESCE(proposal_executed_at, quote_created_at) AS event_time,
                CASE
                    WHEN transaction_type = 'sent'
                        THEN COALESCE(origin_asset, destination_asset)
                    ELSE destination_asset
                END AS leg_token_id,
                CASE
                    WHEN transaction_type = 'sent'
                        THEN -COALESCE(amount_in, 0)
                    WHEN transaction_type = 'deposit'
                        THEN COALESCE(destination_balance_after, 0)
                           - COALESCE(destination_balance_before, 0)
                    ELSE amount_out
                END AS leg_amount,
                CASE
                    WHEN transaction_type = 'sent' THEN dao_id
                    ELSE counterparty
                END AS leg_from_account,
                CASE
                    WHEN transaction_type = 'sent' THEN recipient
                    ELSE dao_id
                END AS leg_to_account
            FROM gold_confidential_history_events
            WHERE dao_id = "#,
    );
    builder.push_bind(&dao_id);
    builder.push(" AND transaction_type IN ('sent', 'deposit', 'exchange')");
    builder.push(
        r#"
        )
        SELECT
            id, history_event_id, dao_id, transaction_type,
            origin_asset, destination_asset,
            amount_in, amount_out, amount_in_usd, amount_out_usd,
            origin_balance_before, origin_balance_after,
            destination_balance_before, destination_balance_after,
            recipient, counterparty,
            proposal_execution_block_height,
            proposal_executed_at,
            proposal_execution_transaction_hash,
            quote_created_at, created_at, proposal_id,
            deposit_tx_hash
        FROM legs
        WHERE 1 = 1
        "#,
    );

    if let Some(start) = start_date {
        builder.push(" AND event_time >= ");
        builder.push_bind(start);
    }
    if let Some(end) = end_date {
        builder.push(" AND event_time <= ");
        builder.push_bind(end);
    }

    if let Some(types) = directional_types.as_ref() {
        builder.push(" AND transaction_type IN (");
        let mut sep = builder.separated(", ");
        for t in types {
            sep.push_bind(*t);
        }
        builder.push(")");
    }

    if let Some(tx_hash) = params.tx_hash.as_ref().filter(|s| !s.is_empty()) {
        builder.push(" AND proposal_execution_transaction_hash ILIKE ");
        builder.push_bind(format!("%{}%", tx_hash));
    }

    if let Some(tokens) = params.token_ids.as_ref().filter(|t| !t.is_empty()) {
        builder.push(" AND leg_token_id = ANY(");
        builder.push_bind(tokens.clone());
        builder.push(")");
    }
    if let Some(exclude) = params.exclude_token_ids.as_ref().filter(|t| !t.is_empty()) {
        builder.push(" AND NOT (leg_token_id = ANY(");
        builder.push_bind(exclude.clone());
        builder.push("))");
    }

    if let Some(from_allow) = from_allow.as_ref() {
        builder.push(" AND leg_from_account = ANY(");
        builder.push_bind(from_allow);
        builder.push(")");
    }
    if let Some(from_deny) = from_deny.as_ref() {
        builder.push(" AND NOT (leg_from_account = ANY(");
        builder.push_bind(from_deny);
        builder.push("))");
    }
    if let Some(to_allow) = to_allow.as_ref() {
        builder.push(" AND leg_to_account = ANY(");
        builder.push_bind(to_allow);
        builder.push(")");
    }
    if let Some(to_deny) = to_deny.as_ref() {
        builder.push(" AND NOT (leg_to_account = ANY(");
        builder.push_bind(to_deny);
        builder.push("))");
    }

    if let Some(min) = min_amount {
        builder.push(" AND ABS(leg_amount) >= ");
        builder.push_bind(min);
    }
    if let Some(max) = max_amount {
        builder.push(" AND ABS(leg_amount) <= ");
        builder.push_bind(max);
    }

    builder.push(" ORDER BY event_time DESC, id DESC");

    if params.limit.is_some() || params.offset.is_some() {
        let limit = params.limit.unwrap_or(100).min(1000);
        let offset = params.offset.unwrap_or(0);
        builder.push(" LIMIT ");
        builder.push_bind(limit);
        builder.push(" OFFSET ");
        builder.push_bind(offset);
    }

    let rows: Vec<ConfidentialBalanceChangeRow> = builder
        .build_query_as::<ConfidentialBalanceChangeRow>()
        .fetch_all(&state.db_pool)
        .await?;

    let leg_rows: Vec<LegRow> = rows.into_iter().filter_map(LegRow::from_gold).collect();

    // Resolve defuse-format gold asset ids through the shared token metadata pipeline
    // (counterparties → tokens.json → chaindefuser) before enriching swap legs.
    let metadata_map = {
        let ids = collect_leg_token_ids(&leg_rows);
        if ids.is_empty() {
            HashMap::new()
        } else {
            fetch_tokens_with_fallback(
                state,
                &ids,
                params.include_chain_metadata.unwrap_or(false),
                false,
            )
            .await
        }
    };

    let mut enriched: Vec<EnrichedBalanceChange> = leg_rows
        .iter()
        .map(|leg| leg.to_enriched(&dao_id, &metadata_map))
        .collect();

    if params.include_metadata.unwrap_or(false) {
        for change in &mut enriched {
            change.token_metadata = metadata_map.get(&change.token_id).cloned();
        }
    }

    // Confidential rows carry the exact quote-time USD in `usd_value`, so the read
    // paths (recent-activity, export, min_usd_value) use that directly. No historical
    // price-table lookup is needed here.

    Ok(enriched)
}

#[derive(Debug)]
enum DirectionFilter {
    Empty,
    Types(Vec<ConfidentialTxType>),
}

fn classify_direction_filter(types: &[String]) -> DirectionFilter {
    let mut allowed = HashSet::new();
    for t in types {
        match t.as_str() {
            "incoming" => {
                allowed.insert(ConfidentialTxType::Deposit);
            }
            "outgoing" => {
                allowed.insert(ConfidentialTxType::Sent);
            }
            "exchange" => {
                allowed.insert(ConfidentialTxType::Exchange);
            }
            "staking_rewards" => {} // no-op: confidential has no staking
            "all" => {
                allowed.insert(ConfidentialTxType::Deposit);
                allowed.insert(ConfidentialTxType::Exchange);
                allowed.insert(ConfidentialTxType::Sent);
            }
            _ => {}
        }
    }
    if allowed.is_empty() {
        DirectionFilter::Empty
    } else {
        DirectionFilter::Types(allowed.into_iter().collect())
    }
}

fn collect_leg_token_ids(leg_rows: &[LegRow]) -> Vec<String> {
    let mut token_ids = HashSet::new();
    for leg in leg_rows {
        token_ids.insert(leg.token_id.clone());
        if let Some(sent) = leg.swap_sent_token.as_ref() {
            token_ids.insert(sent.clone());
        }
        if let Some(other) = leg.swap_other_token.as_ref() {
            token_ids.insert(other.clone());
        }
        if let Some(received) = leg.swap_received_token.as_ref() {
            token_ids.insert(received.clone());
        }
    }
    token_ids.into_iter().collect()
}

struct LegRow {
    id: i64,
    token_id: String,
    amount: BigDecimal,
    balance_before: BigDecimal,
    balance_after: BigDecimal,
    counterparty: Option<String>,
    signer_id: Option<String>,
    receiver_id: Option<String>,
    block_height: i64,
    block_time: DateTime<Utc>,
    transaction_hash: Option<String>,
    created_at: DateTime<Utc>,
    proposal_id: Option<i64>,
    usd_value: Option<BigDecimal>,
    action_kind: String,
    swap_sent_token: Option<String>,
    swap_sent_amount: Option<BigDecimal>,
    swap_other_token: Option<String>,
    swap_received_token: Option<String>,
    swap_received_amount: Option<BigDecimal>,
    swap_solver_tx: Option<String>,
}

impl LegRow {
    fn from_gold(row: ConfidentialBalanceChangeRow) -> Option<Self> {
        let ConfidentialBalanceChangeRow {
            id,
            history_event_id,
            dao_id,
            transaction_type,
            origin_asset,
            destination_asset,
            amount_in,
            amount_out,
            amount_in_usd,
            amount_out_usd,
            origin_balance_before,
            origin_balance_after,
            destination_balance_before,
            destination_balance_after,
            recipient,
            counterparty,
            proposal_execution_block_height,
            proposal_executed_at,
            proposal_execution_transaction_hash,
            quote_created_at,
            created_at,
            proposal_id,
            deposit_tx_hash,
        } = row;

        let resolved_block_time = proposal_executed_at.unwrap_or(quote_created_at);
        let block_height = proposal_execution_block_height.unwrap_or(0);
        let transaction_hash = proposal_execution_transaction_hash;

        let dao_id_str = dao_id.as_str().to_string();
        match transaction_type {
            ConfidentialTxType::Sent => {
                let token_id = origin_asset
                    .clone()
                    .unwrap_or_else(|| destination_asset.clone());
                let amount_abs = amount_in.unwrap_or_else(BigDecimal::zero);
                Some(LegRow {
                    id,
                    token_id,
                    amount: -amount_abs,
                    balance_before: origin_balance_before.unwrap_or_else(BigDecimal::zero),
                    balance_after: origin_balance_after.unwrap_or_else(BigDecimal::zero),
                    counterparty: Some(recipient.clone()),
                    signer_id: Some(dao_id_str),
                    receiver_id: Some(recipient),
                    block_height,
                    block_time: resolved_block_time,
                    transaction_hash,
                    created_at,
                    proposal_id,
                    usd_value: amount_in_usd,
                    action_kind: "ConfidentialSend".to_string(),
                    swap_sent_token: None,
                    swap_sent_amount: None,
                    swap_other_token: None,
                    swap_received_token: None,
                    swap_received_amount: None,
                    swap_solver_tx: None,
                })
            }
            ConfidentialTxType::Deposit => {
                let balance_before = destination_balance_before.unwrap_or_else(BigDecimal::zero);
                let balance_after = destination_balance_after.unwrap_or_else(BigDecimal::zero);
                // Match gold ledger delta (amount_out - amount_in for same-asset fees), not
                // gross amount_out — keeps amount = balance_after - balance_before.
                let amount = &balance_after - &balance_before;
                // Use the deposit tx hash as the transaction identifier when there
                // is no NEAR proposal execution tx (typical for pure deposits).
                // counterparty already holds the real on-chain sender (set in classify.rs).
                let resolved_tx_hash = transaction_hash.or(deposit_tx_hash);
                Some(LegRow {
                    id,
                    token_id: destination_asset,
                    amount,
                    balance_before,
                    balance_after,
                    counterparty: Some(counterparty.clone()),
                    signer_id: Some(counterparty),
                    receiver_id: Some(dao_id_str),
                    block_height,
                    block_time: resolved_block_time,
                    transaction_hash: resolved_tx_hash,
                    created_at,
                    proposal_id,
                    usd_value: amount_out_usd,
                    action_kind: "ConfidentialDeposit".to_string(),
                    swap_sent_token: None,
                    swap_sent_amount: None,
                    swap_other_token: None,
                    swap_received_token: None,
                    swap_received_amount: None,
                    swap_solver_tx: None,
                })
            }
            ConfidentialTxType::Exchange => {
                let solver_tx = transaction_hash
                    .clone()
                    .unwrap_or_else(|| format!("confidential:{}", history_event_id));
                Some(LegRow {
                    id,
                    token_id: destination_asset.clone(),
                    amount: amount_out.clone(),
                    balance_before: destination_balance_before.unwrap_or_else(BigDecimal::zero),
                    balance_after: destination_balance_after.unwrap_or_else(BigDecimal::zero),
                    counterparty: Some(counterparty.clone()),
                    signer_id: Some(counterparty),
                    receiver_id: Some(dao_id_str),
                    block_height,
                    block_time: resolved_block_time,
                    transaction_hash,
                    created_at,
                    proposal_id,
                    usd_value: amount_out_usd,
                    action_kind: "ConfidentialExchange".to_string(),
                    swap_sent_token: origin_asset.clone(),
                    swap_sent_amount: amount_in,
                    swap_other_token: origin_asset,
                    swap_received_token: Some(destination_asset),
                    swap_received_amount: Some(amount_out),
                    swap_solver_tx: Some(solver_tx),
                })
            }
        }
    }

    fn to_enriched(
        &self,
        dao_id: &str,
        metadata_map: &HashMap<String, TokenMetadata>,
    ) -> EnrichedBalanceChange {
        EnrichedBalanceChange {
            id: self.id,
            account_id: dao_id.to_string(),
            block_height: self.block_height,
            block_time: self.block_time,
            token_id: self.token_id.clone(),
            receipt_id: Vec::new(),
            transaction_hashes: self
                .transaction_hash
                .clone()
                .map(|h| vec![h])
                .unwrap_or_default(),
            counterparty: self.counterparty.clone(),
            signer_id: self.signer_id.clone(),
            receiver_id: self.receiver_id.clone(),
            amount: self.amount.clone(),
            balance_before: self.balance_before.clone(),
            balance_after: self.balance_after.clone(),
            created_at: self.created_at,
            token_metadata: None,
            swap: self.build_swap_info(metadata_map),
            action_kind: Some(self.action_kind.clone()),
            method_name: None,
            actions: None,
            usd_value: self.usd_value.clone(),
            proposal_id: self.proposal_id,
        }
    }

    fn build_swap_info(&self, metadata_map: &HashMap<String, TokenMetadata>) -> Option<SwapInfo> {
        let received_token_id = self.swap_received_token.clone()?;
        let solver = self.swap_solver_tx.clone()?;
        let received_token_metadata = metadata_map.get(&received_token_id).cloned()?;
        let sent_token_metadata = self
            .swap_sent_token
            .as_ref()
            .and_then(|id| metadata_map.get(id).cloned());

        Some(SwapInfo {
            sent_token_id: self.swap_sent_token.clone(),
            sent_amount: self.swap_sent_amount.clone(),
            sent_token_metadata,
            received_token_id,
            received_amount: self.swap_received_amount.clone(),
            received_token_metadata,
            solver_transaction_hash: solver,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use crate::routes::BalanceChangesQuery;
    use sqlx::PgPool;
    use std::sync::Arc;
    use uuid::Uuid;

    fn test_params(
        dao_id: &str,
        to_accounts: Option<Vec<String>>,
        to_accounts_not: Option<Vec<String>>,
    ) -> BalanceChangesQuery {
        BalanceChangesQuery {
            account_id: dao_id.parse().expect("test DAO should be valid"),
            limit: None,
            offset: None,
            start_time: None,
            end_time: None,
            token_ids: None,
            exclude_token_ids: None,
            transaction_types: None,
            min_amount: None,
            max_amount: None,
            tx_hash: None,
            from_accounts: None,
            from_accounts_not: None,
            to_accounts,
            to_accounts_not,
            include_metadata: Some(false),
            include_prices: Some(false),
            include_chain_metadata: Some(false),
            exclude_near_dust: false,
            exclude_swaps_from_direction: false,
        }
    }

    async fn test_state(pool: PgPool) -> Arc<AppState> {
        Arc::new(
            AppState::builder()
                .db_pool(pool)
                .build()
                .await
                .expect("test AppState should build"),
        )
    }

    async fn seed_sent_confidential_change(
        pool: &PgPool,
        dao_id: &str,
        recipient: &str,
    ) -> Result<(), sqlx::Error> {
        let now = chrono::Utc::now();
        let deposit_address = format!("deposit-{}", Uuid::new_v4());
        let event_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO bronze_confidential_history_events (
                account_id, created_at_external, deposit_address, status,
                deposit_type, recipient_type, recipient, destination_asset, raw_payload
            )
            VALUES ($1, $2, $3, 'SUCCESS',
                'CONFIDENTIAL_INTENTS', 'NEAR', $4, 'nep141:usdc.near', '{}'::jsonb
            )
            RETURNING id
            "#,
        )
        .bind(dao_id)
        .bind(now)
        .bind(&deposit_address)
        .bind(recipient)
        .fetch_one(pool)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO gold_confidential_history_events (
                history_event_id, dao_id, transaction_type,
                origin_asset, destination_asset, amount_in, amount_out,
                origin_balance_before, origin_balance_after,
                recipient, refund_to, counterparty, deposit_address,
                quote_created_at, proposal_executed_at
            )
            VALUES (
                $1, $2, 'sent',
                'nep141:usdc.near', 'nep141:usdc.near', 5, 0,
                10, 5,
                $3, $2, $3, $4,
                $5, $5
            )
            "#,
        )
        .bind(event_id)
        .bind(dao_id)
        .bind(recipient)
        .bind(&deposit_address)
        .bind(now)
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Same-asset deposit with fees: gold ledger uses net (out - in), not gross out.
    async fn seed_same_asset_fee_deposit(pool: &PgPool, dao_id: &str) -> Result<(), sqlx::Error> {
        use std::str::FromStr;

        let now = chrono::Utc::now();
        let deposit_address = format!("deposit-{}", Uuid::new_v4());
        let event_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO bronze_confidential_history_events (
                account_id, created_at_external, deposit_address, status,
                deposit_type, recipient_type, recipient, origin_asset,
                destination_asset, raw_payload
            )
            VALUES ($1, $2, $3, 'SUCCESS',
                'CONFIDENTIAL_INTENTS', 'CONFIDENTIAL_INTENTS', $1,
                'nep141:usdc.near', 'nep141:usdc.near', '{}'::jsonb
            )
            RETURNING id
            "#,
        )
        .bind(dao_id)
        .bind(now)
        .bind(&deposit_address)
        .fetch_one(pool)
        .await?;

        let balance_before = BigDecimal::from(10);
        let balance_after = BigDecimal::from_str("9.6").expect("valid decimal");
        sqlx::query(
            r#"
            INSERT INTO gold_confidential_history_events (
                history_event_id, dao_id, transaction_type,
                origin_asset, destination_asset, amount_in, amount_out,
                destination_balance_before, destination_balance_after,
                recipient, refund_to, counterparty, deposit_address,
                quote_created_at, proposal_executed_at
            )
            VALUES (
                $1, $2, 'deposit',
                'nep141:usdc.near', 'nep141:usdc.near', 1, 0.6,
                $3, $4,
                $2, $2, 'intents.near', $5,
                $6, $6
            )
            "#,
        )
        .bind(event_id)
        .bind(dao_id)
        .bind(&balance_before)
        .bind(&balance_after)
        .bind(&deposit_address)
        .bind(now)
        .execute(pool)
        .await?;

        Ok(())
    }

    #[test]
    fn normalize_account_filter_values_strips_near_prefix() {
        let values = normalize_account_filter_values(&["near:bob.near".to_string()]);
        assert_eq!(values, vec!["bob.near".to_string()]);
    }

    #[test]
    fn normalize_account_filter_values_keeps_bare_near() {
        let values = normalize_account_filter_values(&["bob.near".to_string()]);
        assert_eq!(values, vec!["bob.near".to_string()]);
    }

    #[test]
    fn normalize_account_filter_values_strips_cross_chain_prefix() {
        let values = normalize_account_filter_values(&["arb:0xabc".to_string()]);
        assert_eq!(values, vec!["0xabc".to_string()]);
    }

    #[sqlx::test]
    async fn confidential_to_accounts_filter_matches_bare_sent_recipient(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let dao_id = format!("conf-list-{}.sputnik-dao.near", Uuid::new_v4());
        let state = test_state(pool.clone()).await;
        seed_sent_confidential_change(&pool, &dao_id, "bob.near").await?;

        let included = fetch_balance_change_legs(
            &state,
            &test_params(&dao_id, Some(vec!["bob.near".to_string()]), None),
        )
        .await
        .expect("bare filter should match bare gold recipient");
        assert_eq!(included.len(), 1);

        let included_prefixed = fetch_balance_change_legs(
            &state,
            &test_params(&dao_id, Some(vec!["near:bob.near".to_string()]), None),
        )
        .await
        .expect("prefixed filter should normalize to bare gold recipient");
        assert_eq!(included_prefixed.len(), 1);

        let excluded = fetch_balance_change_legs(
            &state,
            &test_params(&dao_id, None, Some(vec!["bob.near".to_string()])),
        )
        .await
        .expect("bare filter should exclude bare gold recipient");
        assert!(excluded.is_empty());

        Ok(())
    }

    #[sqlx::test]
    async fn confidential_deposit_amount_matches_balance_delta_not_gross_out(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        use std::str::FromStr;

        let dao_id = format!("conf-list-{}.sputnik-dao.near", Uuid::new_v4());
        let state = test_state(pool.clone()).await;
        seed_same_asset_fee_deposit(&pool, &dao_id).await?;

        let legs = fetch_balance_change_legs(&state, &test_params(&dao_id, None, None))
            .await
            .expect("deposit leg should load");
        assert_eq!(legs.len(), 1);

        let leg = &legs[0];
        let expected = BigDecimal::from_str("-0.4").expect("valid decimal");
        assert_eq!(leg.amount, expected);
        assert_eq!(
            leg.amount,
            &leg.balance_after - &leg.balance_before,
            "amount must equal balance_after - balance_before"
        );
        assert!(
            leg.amount < BigDecimal::from_str("0.6").expect("valid decimal"),
            "gross amount_out must not be surfaced when net balance decreased"
        );

        Ok(())
    }
}
