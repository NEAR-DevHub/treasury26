//! Read-side adapter that lets `/api/balance-changes`, `/api/recent-activity`,
//! and `/api/balance-history/export` serve confidential DAOs from
//! `confidential_balance_changes` while keeping the response shape
//! (`EnrichedBalanceChange`) identical to the public list.
//!
//! Exchange Gold rows surface as a single Exchange Fulfillment row (the
//! request side is intentionally hidden for confidential DAOs).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bigdecimal::{BigDecimal, FromPrimitive, Zero};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, QueryBuilder};

use crate::AppState;
use crate::handlers::token::{TokenMetadata, fetch_tokens_with_fallback};
use crate::routes::{BalanceChangesQuery, EnrichedBalanceChange, SwapInfo};

const SENT_LEG_TO_ACCOUNT_EXPR: &str = "regexp_replace(recipient, '^near:', '')";

#[derive(Debug, sqlx::FromRow)]
struct ConfidentialBalanceChangeRow {
    id: i64,
    history_event_id: i64,
    dao_id: String,
    transaction_type: String,
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
    block_height: Option<i64>,
    block_time: Option<DateTime<Utc>>,
    transaction_hash: Option<String>,
    quote_created_at: DateTime<Utc>,
    executed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    proposal_id: Option<i64>,
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

    // Apply token / account / amount / date filters in SQL *before* pagination
    // so a small limit can't drop legs that would otherwise match the filter
    // (the old in-Rust filter ran post-limit). Date sort/filter uses
    // event_time (block_time → executed_at → quote_created_at) rather than
    // confidential_balance_changes.created_at, which is the projection insert
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
                block_height, block_time, transaction_hash,
                quote_created_at, executed_at, created_at,
                (
                    SELECT ci.proposal_id
                    FROM confidential_intents ci
                    WHERE ci.id = confidential_balance_changes.intent_id
                ) AS proposal_id,
                COALESCE(block_time, executed_at, quote_created_at) AS event_time,
                CASE
                    WHEN transaction_type = 'sent'
                        THEN COALESCE(origin_asset, destination_asset)
                    ELSE destination_asset
                END AS leg_token_id,
                CASE
                    WHEN transaction_type = 'sent'
                        THEN -COALESCE(amount_in, 0)
                    ELSE amount_out
                END AS leg_amount,
                CASE
                    WHEN transaction_type = 'sent' THEN dao_id
                    ELSE counterparty
                END AS leg_from_account,
                CASE
                    WHEN transaction_type = 'sent' THEN "#,
    );
    builder.push(SENT_LEG_TO_ACCOUNT_EXPR);
    builder.push(
        r#"
                    ELSE dao_id
                END AS leg_to_account
            FROM confidential_balance_changes
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
            block_height, block_time, transaction_hash,
            quote_created_at, executed_at, created_at, proposal_id
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
        builder.push(" AND transaction_hash ILIKE ");
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

    if let Some(from_allow) = params.from_accounts.as_ref().filter(|t| !t.is_empty()) {
        builder.push(" AND leg_from_account = ANY(");
        builder.push_bind(from_allow.clone());
        builder.push(")");
    }
    if let Some(from_deny) = params.from_accounts_not.as_ref().filter(|t| !t.is_empty()) {
        builder.push(" AND NOT (leg_from_account = ANY(");
        builder.push_bind(from_deny.clone());
        builder.push("))");
    }
    if let Some(to_allow) = params.to_accounts.as_ref().filter(|t| !t.is_empty()) {
        builder.push(" AND leg_to_account = ANY(");
        builder.push_bind(to_allow.clone());
        builder.push(")");
    }
    if let Some(to_deny) = params.to_accounts_not.as_ref().filter(|t| !t.is_empty()) {
        builder.push(" AND NOT (leg_to_account = ANY(");
        builder.push_bind(to_deny.clone());
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

    let mut enriched: Vec<EnrichedBalanceChange> = leg_rows
        .iter()
        .map(|leg| leg.to_enriched(&dao_id))
        .collect();

    let metadata_map =
        if params.include_metadata.unwrap_or(false) || params.include_prices.unwrap_or(false) {
            let mut token_ids: HashSet<String> = HashSet::new();
            for leg in &leg_rows {
                token_ids.insert(leg.token_id.clone());
                if let Some(other) = leg.swap_other_token.as_ref() {
                    token_ids.insert(other.clone());
                }
            }
            let ids: Vec<String> = token_ids.into_iter().collect();
            fetch_tokens_with_fallback(state, &ids, params.include_chain_metadata.unwrap_or(false))
                .await
        } else {
            HashMap::new()
        };

    if params.include_metadata.unwrap_or(false) {
        for change in &mut enriched {
            change.token_metadata = metadata_map.get(&change.token_id).cloned();
        }
    }

    for (change, leg) in enriched.iter_mut().zip(leg_rows.iter()) {
        if let Some(swap) = leg.build_swap_info(&metadata_map) {
            change.swap = Some(swap);
        }
    }

    if params.include_prices.unwrap_or(false) {
        attach_prices(state, &mut enriched).await;
    }

    Ok(enriched)
}

#[derive(Debug)]
enum DirectionFilter {
    Empty,
    Types(Vec<&'static str>),
}

fn classify_direction_filter(types: &[String]) -> DirectionFilter {
    let mut allowed = HashSet::new();
    for t in types {
        match t.as_str() {
            "incoming" => {
                allowed.insert("deposit");
            }
            "outgoing" => {
                allowed.insert("sent");
            }
            "exchange" => {
                allowed.insert("exchange");
            }
            "staking_rewards" => {} // no-op: confidential has no staking
            "all" => {
                allowed.insert("deposit");
                allowed.insert("exchange");
                allowed.insert("sent");
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
            block_height,
            block_time,
            transaction_hash,
            quote_created_at,
            executed_at,
            created_at,
            proposal_id,
        } = row;

        let resolved_block_time = block_time.or(executed_at).unwrap_or(quote_created_at);
        let block_height = block_height.unwrap_or(0);

        match transaction_type.as_str() {
            "sent" => {
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
                    signer_id: Some(dao_id),
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
            "deposit" => Some(LegRow {
                id,
                token_id: destination_asset,
                amount: amount_out,
                balance_before: destination_balance_before.unwrap_or_else(BigDecimal::zero),
                balance_after: destination_balance_after.unwrap_or_else(BigDecimal::zero),
                counterparty: Some(counterparty.clone()),
                signer_id: Some(counterparty),
                receiver_id: Some(dao_id),
                block_height,
                block_time: resolved_block_time,
                transaction_hash,
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
            }),
            "exchange" => {
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
                    receiver_id: Some(dao_id),
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
            _ => None,
        }
    }

    fn to_enriched(&self, dao_id: &str) -> EnrichedBalanceChange {
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
            swap: None,
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
        let sent_token_metadata = self
            .swap_sent_token
            .as_ref()
            .map(|id| resolve_swap_metadata(id, metadata_map));
        let received_token_metadata = resolve_swap_metadata(&received_token_id, metadata_map);

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

fn resolve_swap_metadata(
    token_id: &str,
    metadata_map: &HashMap<String, TokenMetadata>,
) -> TokenMetadata {
    if let Some(meta) = metadata_map.get(token_id) {
        return meta.clone();
    }
    let symbol = token_id
        .split('.')
        .next()
        .unwrap_or("UNKNOWN")
        .to_uppercase();
    TokenMetadata {
        token_id: token_id.to_string(),
        name: symbol.clone(),
        symbol,
        decimals: 18,
        icon: None,
        price: None,
        price_updated_at: None,
        network: None,
        chain_name: None,
        chain_icons: None,
    }
}

async fn attach_prices(state: &Arc<AppState>, enriched: &mut [EnrichedBalanceChange]) {
    let mut token_dates: HashMap<String, HashSet<chrono::NaiveDate>> = HashMap::new();
    for change in enriched.iter() {
        token_dates
            .entry(change.token_id.clone())
            .or_default()
            .insert(change.block_time.date_naive());
    }

    let mut all_prices: HashMap<String, HashMap<chrono::NaiveDate, f64>> = HashMap::new();
    for (token_id, dates) in token_dates {
        let dates_vec: Vec<chrono::NaiveDate> = dates.into_iter().collect();
        match state
            .price_service
            .get_prices_batch(&token_id, &dates_vec)
            .await
        {
            Ok(prices) => {
                all_prices.insert(token_id, prices);
            }
            Err(e) => {
                log::warn!(
                    "[confidential-balance-list] price lookup failed for {}: {}",
                    token_id,
                    e
                );
            }
        }
    }

    for change in enriched.iter_mut() {
        let Some(ref mut metadata) = change.token_metadata else {
            continue;
        };
        let date = change.block_time.date_naive();
        if let Some(prices) = all_prices.get(&change.token_id)
            && let Some(&price) = prices.get(&date)
        {
            metadata.price = Some(price);
        }
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
            INSERT INTO confidential_history_events (
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
            INSERT INTO confidential_balance_changes (
                history_event_id, dao_id, transaction_type,
                origin_asset, destination_asset, amount_in, amount_out,
                origin_balance_before, origin_balance_after,
                recipient, refund_to, counterparty, deposit_address,
                quote_created_at, executed_at, block_time
            )
            VALUES (
                $1, $2, 'sent',
                'nep141:usdc.near', 'nep141:usdc.near', 5, 0,
                10, 5,
                $3, $2, $3, $4,
                $5, $5, $5
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

    #[test]
    fn confidential_sent_to_account_filter_sql_strips_near_prefix() {
        assert_eq!(
            SENT_LEG_TO_ACCOUNT_EXPR,
            "regexp_replace(recipient, '^near:', '')"
        );
    }

    #[sqlx::test]
    async fn confidential_to_accounts_filter_matches_prefixed_sent_recipient(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let dao_id = format!("conf-list-{}.sputnik-dao.near", Uuid::new_v4());
        let state = test_state(pool.clone()).await;
        seed_sent_confidential_change(&pool, &dao_id, "near:bob.near").await?;

        let included = fetch_balance_change_legs(
            &state,
            &test_params(&dao_id, Some(vec!["bob.near".to_string()]), None),
        )
        .await
        .expect("prefixed recipient should be queryable by plain account");
        assert_eq!(included.len(), 1);

        let excluded = fetch_balance_change_legs(
            &state,
            &test_params(&dao_id, None, Some(vec!["bob.near".to_string()])),
        )
        .await
        .expect("prefixed recipient should be excludable by plain account");
        assert!(excluded.is_empty());

        Ok(())
    }

    #[sqlx::test]
    async fn confidential_to_accounts_filter_keeps_unprefixed_sent_recipient(
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
        .expect("unprefixed recipient should still match plain account");
        assert_eq!(included.len(), 1);

        let excluded = fetch_balance_change_legs(
            &state,
            &test_params(&dao_id, None, Some(vec!["bob.near".to_string()])),
        )
        .await
        .expect("unprefixed recipient should still be excluded by plain account");
        assert!(excluded.is_empty());

        Ok(())
    }
}
