//! Read-side adapter for public DAOs backed by `gold_treasury_ledger_events`.
//!
//! This mirrors `confidential_list`: callers keep using `EnrichedBalanceChange`
//! while the backing table switches from legacy `balance_changes` to the
//! unified gold ledger.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bigdecimal::{BigDecimal, FromPrimitive, Zero};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, QueryBuilder, Row};

use crate::AppState;
use crate::handlers::balance_changes::token_filter::push_token_match;
use crate::handlers::public_history::quotes::{
    proposal_quote_from_metadata, quote_destination_token_id,
};
use crate::handlers::token::{TokenMetadata, fetch_tokens_with_fallback};
use crate::routes::{BalanceChangesQuery, EnrichedBalanceChange, SwapInfo};

#[derive(Debug)]
struct PublicGoldRow {
    id: i64,
    dao_id: String,
    transaction_type: String,
    token_in: Option<String>,
    token_out: Option<String>,
    amount_in: Option<BigDecimal>,
    amount_out: Option<BigDecimal>,
    amount_in_usd: Option<BigDecimal>,
    amount_out_usd: Option<BigDecimal>,
    usd_change: Option<BigDecimal>,
    token_in_balance_before: Option<BigDecimal>,
    token_in_balance_after: Option<BigDecimal>,
    token_out_balance_before: Option<BigDecimal>,
    token_out_balance_after: Option<BigDecimal>,
    recipient: Option<String>,
    counterparty: Option<String>,
    transaction_hash: Option<String>,
    receipt_id: Option<String>,
    block_height: Option<i64>,
    event_time: DateTime<Utc>,
    proposal_id: Option<i64>,
    proposal_execution_transaction_hash: Option<String>,
    status: String,
    quote_metadata: Option<Value>,
    created_at: DateTime<Utc>,
}

impl sqlx::FromRow<'_, sqlx::postgres::PgRow> for PublicGoldRow {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            dao_id: row.try_get("dao_id")?,
            transaction_type: row.try_get("transaction_type")?,
            token_in: row.try_get("token_in")?,
            token_out: row.try_get("token_out")?,
            amount_in: row.try_get("amount_in")?,
            amount_out: row.try_get("amount_out")?,
            amount_in_usd: row.try_get("amount_in_usd")?,
            amount_out_usd: row.try_get("amount_out_usd")?,
            usd_change: row.try_get("usd_change")?,
            token_in_balance_before: row.try_get("token_in_balance_before")?,
            token_in_balance_after: row.try_get("token_in_balance_after")?,
            token_out_balance_before: row.try_get("token_out_balance_before")?,
            token_out_balance_after: row.try_get("token_out_balance_after")?,
            recipient: row.try_get("recipient")?,
            counterparty: row.try_get("counterparty")?,
            transaction_hash: row.try_get("transaction_hash")?,
            receipt_id: row.try_get("receipt_id")?,
            block_height: row.try_get("block_height")?,
            event_time: row.try_get("event_time")?,
            proposal_id: row.try_get("proposal_id")?,
            proposal_execution_transaction_hash: row
                .try_get("proposal_execution_transaction_hash")?,
            status: row.try_get("status")?,
            quote_metadata: row.try_get("quote_metadata")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum DirectionFilter {
    Empty,
    All,
    Typed {
        deposit: bool,
        sent: bool,
        exchange: bool,
    },
}

fn classify_direction_filter(
    types: Option<&Vec<String>>,
    exclude_swaps_from_direction: bool,
) -> DirectionFilter {
    let Some(types) = types else {
        return DirectionFilter::All;
    };
    if types.is_empty() || types.iter().any(|t| t == "all") {
        return DirectionFilter::All;
    }

    let mut deposit = false;
    let mut sent = false;
    let mut exchange = false;
    for t in types {
        match t.as_str() {
            "incoming" => {
                deposit = true;
                if !exclude_swaps_from_direction {
                    exchange = true;
                }
            }
            "outgoing" => {
                sent = true;
                if !exclude_swaps_from_direction {
                    exchange = true;
                }
            }
            "exchange" => exchange = true,
            "staking_rewards" => {}
            _ => {}
        }
    }

    if deposit || sent || exchange {
        DirectionFilter::Typed {
            deposit,
            sent,
            exchange,
        }
    } else {
        DirectionFilter::Empty
    }
}

fn collect_token_ids(legs: &[LegRow]) -> Vec<String> {
    let mut ids = HashSet::new();
    for leg in legs {
        ids.insert(leg.token_id.clone());
        if let Some(token_id) = leg.swap_sent_token.as_ref() {
            ids.insert(token_id.clone());
        }
        if let Some(token_id) = leg.swap_received_token.as_ref() {
            ids.insert(token_id.clone());
        }
    }
    ids.into_iter().collect()
}

fn fallback_metadata(token_id: &str) -> TokenMetadata {
    let symbol = token_id
        .strip_prefix("intents.near:")
        .unwrap_or(token_id)
        .split([':', '.'])
        .next()
        .unwrap_or("UNKNOWN")
        .to_uppercase();
    TokenMetadata {
        token_id: token_id.to_string(),
        name: symbol.clone(),
        symbol,
        decimals: 24,
        icon: None,
        price: None,
        price_updated_at: None,
        network: None,
        chain_name: None,
        chain_icons: None,
    }
}

fn bind_public_filters<'a>(
    mut builder: QueryBuilder<'a, sqlx::Postgres>,
    params: &'a BalanceChangesQuery,
    count_only: bool,
) -> QueryBuilder<'a, sqlx::Postgres> {
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
    let min_amount = params.min_amount.and_then(BigDecimal::from_f64);
    let max_amount = params.max_amount.and_then(BigDecimal::from_f64);

    builder.push(" WHERE dao_id = ");
    builder.push_bind(params.account_id.as_str());
    builder.push(" AND history_visible AND source_kind = 'public_silver_leg'");

    if let Some(start) = start_date {
        builder.push(" AND event_time >= ");
        builder.push_bind(start);
    }
    if let Some(end) = end_date {
        builder.push(" AND event_time <= ");
        builder.push_bind(end);
    }

    match classify_direction_filter(
        params.transaction_types.as_ref(),
        params.exclude_swaps_from_direction,
    ) {
        DirectionFilter::Empty => builder.push(" AND false"),
        DirectionFilter::All => &mut builder,
        DirectionFilter::Typed {
            deposit,
            sent,
            exchange,
        } => {
            let mut transaction_types = Vec::new();
            if deposit {
                transaction_types.push("deposit".to_string());
            }
            if sent {
                transaction_types.push("sent".to_string());
            }
            if exchange {
                transaction_types.push("exchange".to_string());
            }
            builder.push(" AND transaction_type = ANY(");
            builder.push_bind(transaction_types);
            builder.push("::public_transaction_type[])")
        }
    };

    if let Some(tx_hash) = params.tx_hash.as_ref().filter(|s| !s.is_empty()) {
        builder.push(" AND (transaction_hash ILIKE ");
        builder.push_bind(format!("%{}%", tx_hash));
        builder.push(" OR proposal_execution_transaction_hash ILIKE ");
        builder.push_bind(format!("%{}%", tx_hash));
        builder.push(")");
    }

    if let Some(tokens) = params
        .token_ids
        .as_ref()
        .filter(|tokens| !tokens.is_empty())
    {
        builder.push(" AND ");
        push_token_match(&mut builder, &["token_in", "token_out"], tokens);
    }
    if let Some(tokens) = params
        .exclude_token_ids
        .as_ref()
        .filter(|tokens| !tokens.is_empty())
    {
        builder.push(" AND NOT ");
        push_token_match(&mut builder, &["token_in", "token_out"], tokens);
    }

    if let Some(min) = min_amount {
        builder.push(" AND ABS(COALESCE(amount_in, amount_out, 0)) >= ");
        builder.push_bind(min);
    }
    if let Some(max) = max_amount {
        builder.push(" AND ABS(COALESCE(amount_in, amount_out, 0)) <= ");
        builder.push_bind(max);
    }

    if let Some(accounts) = params.from_accounts.as_ref().filter(|v| !v.is_empty()) {
        builder.push(" AND (CASE WHEN transaction_type::text = 'deposit' THEN counterparty ELSE dao_id END) = ANY(");
        builder.push_bind(accounts.clone());
        builder.push(")");
    }
    if let Some(accounts) = params.from_accounts_not.as_ref().filter(|v| !v.is_empty()) {
        builder.push(" AND NOT ((CASE WHEN transaction_type::text = 'deposit' THEN counterparty ELSE dao_id END) = ANY(");
        builder.push_bind(accounts.clone());
        builder.push("))");
    }
    if let Some(accounts) = params.to_accounts.as_ref().filter(|v| !v.is_empty()) {
        builder.push(" AND (CASE WHEN transaction_type::text = 'deposit' THEN dao_id ELSE COALESCE(recipient, counterparty) END) = ANY(");
        builder.push_bind(accounts.clone());
        builder.push(")");
    }
    if let Some(accounts) = params.to_accounts_not.as_ref().filter(|v| !v.is_empty()) {
        builder.push(" AND NOT ((CASE WHEN transaction_type::text = 'deposit' THEN dao_id ELSE COALESCE(recipient, counterparty) END) = ANY(");
        builder.push_bind(accounts.clone());
        builder.push("))");
    }

    if params.exclude_near_dust {
        builder.push(" AND NOT ((token_in = 'near' OR token_out = 'near') AND ABS(COALESCE(amount_in, amount_out, 0)) < 0.09)");
    }

    if !count_only {
        builder.push(" ORDER BY event_time DESC, id DESC");
        if params.limit.is_some() || params.offset.is_some() {
            builder.push(" LIMIT ");
            builder.push_bind(params.limit.unwrap_or(100).min(1000));
            builder.push(" OFFSET ");
            builder.push_bind(params.offset.unwrap_or(0));
        }
    }

    builder
}

pub async fn count_balance_change_legs(
    pool: &PgPool,
    params: &BalanceChangesQuery,
) -> Result<i64, sqlx::Error> {
    let builder =
        QueryBuilder::<sqlx::Postgres>::new("SELECT COUNT(*) FROM gold_treasury_ledger_events");
    let mut builder = bind_public_filters(builder, params, true);
    builder.build_query_scalar::<i64>().fetch_one(pool).await
}

pub async fn load_prior_balances(
    pool: &PgPool,
    account_id: &str,
    start_time: DateTime<Utc>,
    token_ids: Option<&Vec<String>>,
) -> Result<HashMap<String, BigDecimal>, sqlx::Error> {
    // Latest is chain order (block, then intra-block source order), not
    // event_time: same-transaction legs share one event_time, and an id
    // tiebreak there can surface the balance from before the final leg.
    //
    // Each stamp is positioned at the block of the leg it came from, not the
    // row's own block: an exchange row carries the outgoing leg's block, but
    // its token_in stamp belongs to the incoming (counter) leg, which can
    // land blocks later — ordering by the row block would let an older
    // hidden-row stamp shadow it.
    let mut builder = QueryBuilder::<sqlx::Postgres>::new(
        r#"
        SELECT DISTINCT ON (asset) asset, balance
        FROM (
            SELECT gold.token_in AS asset,
                   gold.token_in_user_balance_after AS balance,
                   COALESCE(counter_leg.block_height, primary_leg.block_height,
                            gold.block_height) AS block_height,
                   gold.source_order, gold.event_time, gold.id
            FROM gold_treasury_ledger_events gold
            LEFT JOIN silver_public_transfer_legs primary_leg
              ON primary_leg.id = gold.primary_transfer_leg_id
            LEFT JOIN silver_public_transfer_legs counter_leg
              ON counter_leg.id = gold.counter_transfer_leg_id
            WHERE gold.dao_id = "#,
    );
    builder.push_bind(account_id);
    builder.push(" AND gold.event_time < ");
    builder.push_bind(start_time);
    builder.push(" AND gold.token_in IS NOT NULL AND gold.token_in_user_balance_after IS NOT NULL");

    if let Some(tokens) = token_ids.filter(|tokens| !tokens.is_empty()) {
        builder.push(" AND ");
        push_token_match(&mut builder, &["gold.token_in"], tokens);
    }

    builder.push(
        r#"
            UNION ALL
            SELECT gold.token_out AS asset,
                   gold.token_out_user_balance_after AS balance,
                   COALESCE(primary_leg.block_height, gold.block_height) AS block_height,
                   gold.source_order, gold.event_time, gold.id
            FROM gold_treasury_ledger_events gold
            LEFT JOIN silver_public_transfer_legs primary_leg
              ON primary_leg.id = gold.primary_transfer_leg_id
            WHERE gold.dao_id = "#,
    );
    builder.push_bind(account_id);
    builder.push(" AND gold.event_time < ");
    builder.push_bind(start_time);
    builder
        .push(" AND gold.token_out IS NOT NULL AND gold.token_out_user_balance_after IS NOT NULL");

    if let Some(tokens) = token_ids.filter(|tokens| !tokens.is_empty()) {
        builder.push(" AND ");
        push_token_match(&mut builder, &["gold.token_out"], tokens);
    }

    builder.push(
        r#"
        ) balances
        ORDER BY asset, block_height DESC NULLS LAST, source_order DESC,
                 event_time DESC, id DESC
        "#,
    );

    let rows = builder.build().fetch_all(pool).await?;
    let mut balances = HashMap::new();
    for row in rows {
        balances.insert(row.try_get("asset")?, row.try_get("balance")?);
    }
    Ok(balances)
}

pub async fn fetch_balance_change_legs(
    state: &Arc<AppState>,
    params: &BalanceChangesQuery,
) -> Result<Vec<EnrichedBalanceChange>, Box<dyn std::error::Error + Send + Sync>> {
    // Unified rows carry user-owned balances; balance_before is derived
    // (user_balance_after − signed delta) instead of stored. Visible rows are
    // always user-owned by construction — non-user movements are hidden.
    let builder = QueryBuilder::<sqlx::Postgres>::new(
        r#"
        SELECT
            id,
            dao_id,
            transaction_type::text AS transaction_type,
            token_in,
            token_out,
            amount_in,
            amount_out,
            amount_in_usd,
            amount_out_usd,
            usd_change,
            token_in_user_balance_after - COALESCE(amount_in, 0)
                AS token_in_balance_before,
            token_in_user_balance_after AS token_in_balance_after,
            token_out_user_balance_after + COALESCE(amount_out, 0)
                AS token_out_balance_before,
            token_out_user_balance_after AS token_out_balance_after,
            recipient,
            counterparty,
            transaction_hash,
            receipt_id,
            block_height,
            event_time,
            proposal_id,
            proposal_execution_transaction_hash,
            status::text AS status,
            (
                SELECT proposal.quote_metadata
                FROM dao_proposals proposal
                WHERE proposal.dao_id = gold_treasury_ledger_events.dao_id
                  AND proposal.proposal_id = gold_treasury_ledger_events.proposal_id
            ) AS quote_metadata,
            created_at
        FROM gold_treasury_ledger_events
        "#,
    );
    let mut builder = bind_public_filters(builder, params, false);
    let rows: Vec<PublicGoldRow> = builder.build_query_as().fetch_all(&state.db_pool).await?;

    let legs: Vec<LegRow> = rows.into_iter().flat_map(LegRow::from_gold).collect();

    let metadata_map = {
        let ids = collect_token_ids(&legs);
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

    let mut enriched: Vec<EnrichedBalanceChange> = legs
        .iter()
        .map(|leg| leg.to_enriched(&metadata_map))
        .collect();

    if params.include_metadata.unwrap_or(false) {
        for change in &mut enriched {
            change.token_metadata = Some(
                metadata_map
                    .get(&change.token_id)
                    .cloned()
                    .unwrap_or_else(|| fallback_metadata(&change.token_id)),
            );
        }
    }

    Ok(enriched)
}

#[derive(Debug)]
struct LegRow {
    id: i64,
    account_id: String,
    token_id: String,
    amount: BigDecimal,
    balance_before: BigDecimal,
    balance_after: BigDecimal,
    counterparty: Option<String>,
    signer_id: Option<String>,
    receiver_id: Option<String>,
    block_height: i64,
    block_time: DateTime<Utc>,
    transaction_hashes: Vec<String>,
    receipt_id: Vec<String>,
    created_at: DateTime<Utc>,
    proposal_id: Option<i64>,
    usd_value: Option<BigDecimal>,
    action_kind: String,
    swap_sent_token: Option<String>,
    swap_sent_amount: Option<BigDecimal>,
    swap_sent_amount_usd: Option<BigDecimal>,
    swap_received_token: Option<String>,
    swap_received_amount: Option<BigDecimal>,
    swap_received_amount_usd: Option<BigDecimal>,
    swap_solver_tx: Option<String>,
}

fn pending_exchange_received_token(row: &PublicGoldRow) -> Option<String> {
    if row.status == "success" {
        return None;
    }
    proposal_quote_from_metadata(row.quote_metadata.as_ref())
        .and_then(|quote| quote.destination_asset)
        .map(|destination_asset| quote_destination_token_id(&destination_asset))
}

impl LegRow {
    fn hashes(row: &PublicGoldRow) -> Vec<String> {
        let mut hashes = Vec::new();
        if let Some(hash) = row.transaction_hash.clone() {
            hashes.push(hash);
        }
        if let Some(hash) = row.proposal_execution_transaction_hash.clone()
            && !hashes.contains(&hash)
        {
            hashes.push(hash);
        }
        hashes
    }

    fn from_gold(row: PublicGoldRow) -> Vec<Self> {
        match row.transaction_type.as_str() {
            "deposit" => row
                .token_in
                .clone()
                .map(|token_id| {
                    vec![Self {
                        id: row.id,
                        account_id: row.dao_id.clone(),
                        token_id,
                        amount: row.amount_in.clone().unwrap_or_else(BigDecimal::zero),
                        balance_before: row
                            .token_in_balance_before
                            .clone()
                            .unwrap_or_else(BigDecimal::zero),
                        balance_after: row
                            .token_in_balance_after
                            .clone()
                            .unwrap_or_else(BigDecimal::zero),
                        counterparty: row.counterparty.clone(),
                        signer_id: row.counterparty.clone(),
                        receiver_id: Some(row.dao_id.clone()),
                        block_height: row.block_height.unwrap_or(0),
                        block_time: row.event_time,
                        transaction_hashes: Self::hashes(&row),
                        receipt_id: row
                            .receipt_id
                            .clone()
                            .map(|id| vec![id])
                            .unwrap_or_default(),
                        created_at: row.created_at,
                        proposal_id: row.proposal_id,
                        usd_value: row.amount_in_usd.clone(),
                        action_kind: "PublicDeposit".to_string(),
                        swap_sent_token: None,
                        swap_sent_amount: None,
                        swap_sent_amount_usd: None,
                        swap_received_token: None,
                        swap_received_amount: None,
                        swap_received_amount_usd: None,
                        swap_solver_tx: None,
                    }]
                })
                .unwrap_or_default(),
            // Pending payment rows (approved proposal, transfer not indexed
            // yet) have no balances but must render — they disappear only by
            // being replaced with the real indexed row.
            "sent" => row
                .token_out
                .clone()
                .map(|token_id| {
                    let amount = row.amount_out.clone().unwrap_or_else(BigDecimal::zero);
                    let action_kind = if row.status == "success" {
                        "PublicSent".to_string()
                    } else {
                        format!("PublicSent:{}", row.status)
                    };
                    // Proposal-linked quote rows carry the deposit address as
                    // counterparty; never surface it as the recipient.
                    let receiver = if row.proposal_id.is_some() {
                        row.recipient.clone()
                    } else {
                        row.recipient.clone().or(row.counterparty.clone())
                    };
                    vec![Self {
                        id: row.id,
                        account_id: row.dao_id.clone(),
                        token_id,
                        amount: -amount,
                        balance_before: row
                            .token_out_balance_before
                            .clone()
                            .unwrap_or_else(BigDecimal::zero),
                        balance_after: row
                            .token_out_balance_after
                            .clone()
                            .unwrap_or_else(BigDecimal::zero),
                        counterparty: receiver.clone(),
                        signer_id: Some(row.dao_id.clone()),
                        receiver_id: receiver,
                        block_height: row.block_height.unwrap_or(0),
                        block_time: row.event_time,
                        transaction_hashes: Self::hashes(&row),
                        receipt_id: row
                            .receipt_id
                            .clone()
                            .map(|id| vec![id])
                            .unwrap_or_default(),
                        created_at: row.created_at,
                        proposal_id: row.proposal_id,
                        usd_value: row.amount_out_usd.clone(),
                        action_kind,
                        swap_sent_token: None,
                        swap_sent_amount: None,
                        swap_sent_amount_usd: None,
                        swap_received_token: None,
                        swap_received_amount: None,
                        swap_received_amount_usd: None,
                        swap_solver_tx: None,
                    }]
                })
                .unwrap_or_default(),
            // One row per exchange, carrying the full swap (sent + received)
            // in SwapInfo — the same single Exchange Fulfillment shape the
            // confidential side uses. The request side is intentionally not
            // emitted as its own row.
            "exchange" => row
                .token_in
                .clone()
                .or_else(|| pending_exchange_received_token(&row))
                .or_else(|| row.token_out.clone())
                .map(|token_id| vec![Self::exchange_summary(row, token_id)])
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    fn exchange_summary(row: PublicGoldRow, token_id: String) -> Self {
        let pending_received_token = pending_exchange_received_token(&row);
        let solver = row
            .transaction_hash
            .clone()
            .or_else(|| row.proposal_execution_transaction_hash.clone())
            .unwrap_or_else(|| format!("public-history:{}", row.id));
        Self {
            id: row.id,
            account_id: row.dao_id.clone(),
            token_id,
            amount: row.amount_in.clone().unwrap_or_else(BigDecimal::zero),
            balance_before: row
                .token_in_balance_before
                .clone()
                .unwrap_or_else(BigDecimal::zero),
            balance_after: row
                .token_in_balance_after
                .clone()
                .unwrap_or_else(BigDecimal::zero),
            counterparty: row.counterparty.clone(),
            signer_id: row.counterparty.clone(),
            receiver_id: Some(row.dao_id.clone()),
            block_height: row.block_height.unwrap_or(0),
            block_time: row.event_time,
            transaction_hashes: Self::hashes(&row),
            receipt_id: row
                .receipt_id
                .clone()
                .map(|id| vec![id])
                .unwrap_or_default(),
            created_at: row.created_at,
            proposal_id: row.proposal_id,
            usd_value: row
                .amount_out_usd
                .clone()
                .or_else(|| row.amount_in_usd.clone())
                .or_else(|| row.usd_change.clone()),
            action_kind: format!("PublicExchange:{}", row.status),
            swap_sent_token: row.token_out.clone(),
            swap_sent_amount: row.amount_out.clone(),
            swap_sent_amount_usd: row.amount_out_usd.clone(),
            swap_received_token: row
                .token_in
                .clone()
                .or(pending_received_token)
                .or(row.token_out.clone()),
            swap_received_amount: if row.status == "success" {
                row.amount_in.clone()
            } else {
                None
            },
            swap_received_amount_usd: if row.status == "success" {
                row.amount_in_usd.clone()
            } else {
                None
            },
            swap_solver_tx: Some(solver),
        }
    }

    fn to_enriched(&self, metadata_map: &HashMap<String, TokenMetadata>) -> EnrichedBalanceChange {
        EnrichedBalanceChange {
            id: self.id,
            account_id: self.account_id.clone(),
            block_height: self.block_height,
            block_time: self.block_time,
            token_id: self.token_id.clone(),
            receipt_id: self.receipt_id.clone(),
            transaction_hashes: self.transaction_hashes.clone(),
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
        let solver_transaction_hash = self.swap_solver_tx.clone()?;
        Some(SwapInfo {
            sent_token_id: self.swap_sent_token.clone(),
            sent_amount: self.swap_sent_amount.clone(),
            sent_token_metadata: self.swap_sent_token.as_ref().map(|id| {
                metadata_map
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| fallback_metadata(id))
            }),
            received_token_id: received_token_id.clone(),
            received_amount: self.swap_received_amount.clone(),
            received_token_metadata: metadata_map
                .get(&received_token_id)
                .cloned()
                .unwrap_or_else(|| fallback_metadata(&received_token_id)),
            solver_transaction_hash,
            sent_amount_usd: self.swap_sent_amount_usd.clone(),
            received_amount_usd: self.swap_received_amount_usd.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-02T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn decimal(value: &str) -> BigDecimal {
        value.parse().expect("valid decimal")
    }

    fn base_row(transaction_type: &str) -> PublicGoldRow {
        PublicGoldRow {
            id: 42,
            dao_id: "dao.sputnik-dao.near".to_string(),
            transaction_type: transaction_type.to_string(),
            token_in: None,
            token_out: None,
            amount_in: None,
            amount_out: None,
            amount_in_usd: None,
            amount_out_usd: None,
            usd_change: None,
            token_in_balance_before: None,
            token_in_balance_after: None,
            token_out_balance_before: None,
            token_out_balance_after: None,
            recipient: None,
            counterparty: Some("alice.near".to_string()),
            transaction_hash: Some("tx-hash".to_string()),
            receipt_id: Some("receipt-id".to_string()),
            block_height: Some(100),
            event_time: ts(),
            proposal_id: Some(7),
            proposal_execution_transaction_hash: None,
            status: "success".to_string(),
            quote_metadata: None,
            created_at: ts(),
        }
    }

    #[test]
    fn deposit_maps_to_positive_token_in_leg() {
        let mut row = base_row("deposit");
        row.token_in = Some("nep141:usdc.near".to_string());
        row.amount_in = Some(decimal("12.5"));
        row.token_in_balance_before = Some(decimal("2.5"));
        row.token_in_balance_after = Some(decimal("15"));

        let legs = LegRow::from_gold(row);

        assert_eq!(legs.len(), 1);
        assert_eq!(legs[0].token_id, "nep141:usdc.near");
        assert_eq!(legs[0].amount, decimal("12.5"));
        assert_eq!(legs[0].balance_before, decimal("2.5"));
        assert_eq!(legs[0].balance_after, decimal("15"));
        assert_eq!(legs[0].receiver_id.as_deref(), Some("dao.sputnik-dao.near"));
    }

    #[test]
    fn sent_maps_to_negative_token_out_leg() {
        let mut row = base_row("sent");
        row.token_out = Some("nep141:usdc.near".to_string());
        row.amount_out = Some(decimal("4"));
        row.token_out_balance_before = Some(decimal("9"));
        row.token_out_balance_after = Some(decimal("5"));
        row.recipient = Some("bob.near".to_string());

        let legs = LegRow::from_gold(row);

        assert_eq!(legs.len(), 1);
        assert_eq!(legs[0].token_id, "nep141:usdc.near");
        assert_eq!(legs[0].amount, decimal("-4"));
        assert_eq!(legs[0].balance_before, decimal("9"));
        assert_eq!(legs[0].balance_after, decimal("5"));
        assert_eq!(legs[0].counterparty.as_deref(), Some("bob.near"));
    }

    #[test]
    fn completed_exchange_maps_to_single_swap_summary_for_activity() {
        let mut row = base_row("exchange");
        row.token_in = Some("nep141:usdt.near".to_string());
        row.token_out = Some("nep141:usdc.near".to_string());
        row.amount_in = Some(decimal("9.9"));
        row.amount_out = Some(decimal("10"));
        row.token_in_balance_before = Some(decimal("0"));
        row.token_in_balance_after = Some(decimal("9.9"));
        row.token_out_balance_before = Some(decimal("20"));
        row.token_out_balance_after = Some(decimal("10"));

        let legs = LegRow::from_gold(row);

        assert_eq!(legs.len(), 1);
        assert_eq!(legs[0].token_id, "nep141:usdt.near");
        assert_eq!(legs[0].amount, decimal("9.9"));
        assert_eq!(legs[0].swap_sent_token.as_deref(), Some("nep141:usdc.near"));
        assert_eq!(
            legs[0].swap_received_token.as_deref(),
            Some("nep141:usdt.near")
        );
        assert_eq!(legs[0].swap_received_amount, Some(decimal("9.9")));
    }

    #[test]
    fn exchange_is_always_a_single_row_regardless_of_read_mode() {
        // The request side is never emitted as its own row; both legs live in
        // the one fulfillment row's swap fields, matching confidential.
        let mut row = base_row("exchange");
        row.token_in = Some("nep141:usdt.near".to_string());
        row.token_out = Some("nep141:usdc.near".to_string());
        row.amount_in = Some(decimal("9.9"));
        row.amount_out = Some(decimal("10"));
        row.token_in_balance_before = Some(decimal("0"));
        row.token_in_balance_after = Some(decimal("9.9"));
        row.token_out_balance_before = Some(decimal("20"));
        row.token_out_balance_after = Some(decimal("10"));

        let legs = LegRow::from_gold(row);

        assert_eq!(legs.len(), 1);
        assert_eq!(legs[0].token_id, "nep141:usdt.near");
        assert_eq!(legs[0].amount, decimal("9.9"));
        assert_eq!(legs[0].swap_sent_token.as_deref(), Some("nep141:usdc.near"));
        assert_eq!(legs[0].swap_sent_amount, Some(decimal("10")));
    }

    #[test]
    fn pending_exchange_keeps_received_amount_unknown() {
        let mut row = base_row("exchange");
        row.status = "pending".to_string();
        row.token_out = Some("nep141:usdc.near".to_string());
        row.amount_out = Some(decimal("10"));

        let legs = LegRow::from_gold(row);

        assert_eq!(legs.len(), 1);
        assert_eq!(legs[0].token_id, "nep141:usdc.near");
        assert_eq!(legs[0].swap_received_amount, None);
    }
}
