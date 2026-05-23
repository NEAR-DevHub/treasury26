//! Read-side adapter that lets `/api/balance-changes`, `/api/recent-activity`,
//! and `/api/balance-history/export` serve confidential DAOs from
//! `confidential_balance_changes` while keeping the response shape
//! (`EnrichedBalanceChange`) identical to the public list.
//!
//! Exchange Gold rows surface as a single Exchange Fulfillment row (the
//! request side is intentionally hidden for confidential DAOs).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bigdecimal::{BigDecimal, Zero};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, QueryBuilder};

use crate::AppState;
use crate::handlers::token::{TokenMetadata, fetch_tokens_with_fallback};
use crate::routes::{BalanceChangesQuery, EnrichedBalanceChange, SwapInfo};

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

    let directional = params
        .transaction_types
        .as_ref()
        .map(|types| classify_direction_filter(types));


    let mut builder = QueryBuilder::<sqlx::Postgres>::new(
        r#"
        SELECT
            id, history_event_id, dao_id, transaction_type,
            origin_asset, destination_asset,
            amount_in, amount_out, amount_in_usd, amount_out_usd,
            origin_balance_before, origin_balance_after,
            destination_balance_before, destination_balance_after,
            recipient, counterparty,
            block_height, block_time, transaction_hash,
            quote_created_at, executed_at, created_at
        FROM confidential_balance_changes
        WHERE dao_id = "#,
    );
    builder.push_bind(&dao_id);

    if let Some(start) = start_date {
        builder.push(" AND created_at >= ");
        builder.push_bind(start);
    }
    if let Some(end) = end_date {
        builder.push(" AND created_at <= ");
        builder.push_bind(end);
    }

    if let Some(filter) = &directional {
        match filter {
            DirectionFilter::Empty => return Ok(Vec::new()),
            DirectionFilter::Types(types) => {
                builder.push(" AND transaction_type IN (");
                let mut sep = builder.separated(", ");
                for t in types {
                    sep.push_bind(*t);
                }
                builder.push(")");
            }
        }
    }

    if let Some(tx_hash) = params.tx_hash.as_ref().filter(|s| !s.is_empty()) {
        builder.push(" AND transaction_hash ILIKE ");
        builder.push_bind(format!("%{}%", tx_hash));
    }

    builder.push(" ORDER BY created_at DESC, id DESC");

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

    let mut leg_rows: Vec<LegRow> = rows.into_iter().filter_map(LegRow::from_gold).collect();

    apply_token_filters(
        &mut leg_rows,
        params.token_ids.as_deref(),
        params.exclude_token_ids.as_deref(),
        params.from_accounts.as_deref(),
        params.from_accounts_not.as_deref(),
        params.to_accounts.as_deref(),
        params.to_accounts_not.as_deref(),
    );

    if params.min_amount.is_some() || params.max_amount.is_some() {
        if let Some(decimals) = single_token_decimals(state, params).await {
            let mult = 10f64.powi(decimals as i32);
            let min_raw = params.min_amount.map(|v| v * mult);
            let max_raw = params.max_amount.map(|v| v * mult);
            leg_rows.retain(|leg| {
                let abs = leg
                    .amount
                    .clone()
                    .abs()
                    .to_string()
                    .parse::<f64>()
                    .unwrap_or(0.0);
                if let Some(min) = min_raw
                    && abs < min
                {
                    return false;
                }
                if let Some(max) = max_raw
                    && abs > max
                {
                    return false;
                }
                true
            });
        }
    }

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

fn apply_token_filters(
    legs: &mut Vec<LegRow>,
    token_ids: Option<&[String]>,
    exclude_token_ids: Option<&[String]>,
    from_accounts: Option<&[String]>,
    from_accounts_not: Option<&[String]>,
    to_accounts: Option<&[String]>,
    to_accounts_not: Option<&[String]>,
) {
    legs.retain(|leg| {
        if let Some(whitelist) = token_ids
            && !whitelist.is_empty()
            && !whitelist.contains(&leg.token_id)
        {
            return false;
        }
        if let Some(blacklist) = exclude_token_ids
            && blacklist.contains(&leg.token_id)
        {
            return false;
        }

        let from_account = leg.signer_id.as_deref().unwrap_or("");
        let to_account = leg.receiver_id.as_deref().unwrap_or("");

        if let Some(allow) = from_accounts
            && !allow.is_empty()
            && !allow.iter().any(|a| a == from_account)
        {
            return false;
        }
        if let Some(deny) = from_accounts_not
            && deny.iter().any(|a| a == from_account)
        {
            return false;
        }
        if let Some(allow) = to_accounts
            && !allow.is_empty()
            && !allow.iter().any(|a| a == to_account)
        {
            return false;
        }
        if let Some(deny) = to_accounts_not
            && deny.iter().any(|a| a == to_account)
        {
            return false;
        }
        true
    });
}

async fn single_token_decimals(state: &Arc<AppState>, params: &BalanceChangesQuery) -> Option<u8> {
    let tokens = params.token_ids.as_ref()?;
    if tokens.len() != 1 {
        return None;
    }
    let map = fetch_tokens_with_fallback(state, std::slice::from_ref(&tokens[0]), false).await;
    map.get(&tokens[0]).map(|m| m.decimals)
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
