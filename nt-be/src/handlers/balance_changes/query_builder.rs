use chrono::{DateTime, Utc};
use near_api::AccountId;

/// The relayer account that sponsors users with NEAR for storage deposits.
/// Transactions from/to this account are hidden from users in all activity views.
pub const RELAYER_ACCOUNT: &str = "sponsor.trezu.near";

const RELAYER_WHERE_CONDITION: &str = "counterparty != 'sponsor.trezu.near'";
pub const FROM_ACCOUNT_EXPR: &str = "CASE \
        WHEN amount > 0 THEN COALESCE( \
            NULLIF( \
                CASE \
                    WHEN counterparty = 'STAKING_REWARD' AND token_id LIKE 'staking:%' \
                        THEN substring(token_id FROM 9) \
                    ELSE counterparty \
                END, \
                'UNKNOWN' \
            ), \
            signer_id \
        ) \
        ELSE account_id \
    END";
pub const TO_ACCOUNT_EXPR: &str = "CASE \
        WHEN amount > 0 THEN account_id \
        ELSE COALESCE(NULLIF(counterparty, 'UNKNOWN'), receiver_id) \
    END";

/// Common parameters for filtering balance changes
#[derive(Debug, Clone)]
pub struct BalanceChangeFilters {
    pub account_id: AccountId,

    // Date Filtering
    pub date_cutoff: Option<DateTime<Utc>>, // Minimum date (for plan limits)
    pub start_date: Option<DateTime<Utc>>,  // Custom start date filter
    pub end_date: Option<DateTime<Utc>>,    // Custom end date filter

    // Token Filtering (Whitelist OR Blacklist)
    pub token_ids: Option<Vec<String>>, // Include ONLY these
    pub exclude_token_ids: Option<Vec<String>>, // Exclude these

    // Transaction Type Filtering (can select multiple)
    // "incoming" = received payments (amount > 0, excludes staking rewards)
    // "outgoing" = sent payments (amount < 0)
    // "staking_rewards" = staking rewards only (counterparty = 'STAKING_REWARD')
    // "exchange" = swap/exchange transactions (token_id contains 'intents.near:')
    pub transaction_types: Option<Vec<String>>,

    // Amount Filtering
    pub min_amount: Option<f64>, // Absolute value, decimal-adjusted
    pub max_amount: Option<f64>, // Absolute value, decimal-adjusted

    // Transaction hash search (partial match against any hash in transaction_hashes)
    pub transaction_hash_query: Option<String>,

    // "From" filter values (mapped to displayed "from" account logic)
    pub from_accounts: Option<Vec<String>>,
    pub from_accounts_not: Option<Vec<String>>,
    pub to_accounts: Option<Vec<String>>,
    pub to_accounts_not: Option<Vec<String>>,

    // Filter out tiny NEAR amounts (gas/storage noise) — used by recent activity only
    pub exclude_near_dust: bool,

    // Exclude swaps from incoming/outgoing filters (used by recent activity UI for separate tabs)
    // When true: incoming/outgoing exclude swaps (they go to "exchange" tab)
    // When false: incoming/outgoing include swaps (legacy behavior for exports/API)
    pub exclude_swaps_from_direction: bool,
}

/// Builds WHERE clause conditions for balance changes queries
pub fn build_where_conditions(filters: &BalanceChangeFilters) -> (Vec<String>, usize) {
    let mut conditions = vec![
        "account_id = $1".to_string(),
        "counterparty != 'SNAPSHOT'".to_string(),
        "counterparty != 'STAKING_SNAPSHOT'".to_string(),
        "counterparty != 'NOT_REGISTERED'".to_string(),
        // Exclude zero-change records (internal gap-filler bookkeeping)
        "(amount != 0 OR balance_before != balance_after)".to_string(),
        "(action_kind IS NULL OR action_kind != 'CreateAccount')".to_string(),
        RELAYER_WHERE_CONDITION.to_string(),
    ];

    let mut param_index = 2;

    // Date Filtering
    // date_cutoff is the plan-based minimum date (for history limits)
    if filters.date_cutoff.is_some() {
        conditions.push(format!("block_time >= ${}", param_index));
        param_index += 1;
    }

    // start_date is a user-provided filter
    if filters.start_date.is_some() {
        conditions.push(format!("block_time >= ${}", param_index));
        param_index += 1;
    }

    // end_date is a user-provided filter
    if filters.end_date.is_some() {
        conditions.push(format!("block_time <= ${}", param_index));
        param_index += 1;
    }

    // Token Filtering (Whitelist takes precedence over blacklist)
    // Note: token_id in DB can be in formats:
    //   - "near" (native NEAR)
    //   - "wrap.near" (wrapped NEAR - what the UI sends when filtering by NEAR symbol)
    //   - "staking:pool.near" (staking tokens - transformed to "near" during enrichment)
    //   - "intents.near:nep141:contract.near" (intents with prefix)
    // We need to match both exact token_id and suffix matches for prefixed tokens
    // Special case: if "wrap.near" is in the list, also match "staking:%" and "near" to include staking rewards
    if filters.token_ids.is_some() {
        conditions.push(format!(
            "(token_id = ANY(${0}) OR token_id LIKE ANY(ARRAY(SELECT '%:' || unnest(${0}))) OR (${0} @> ARRAY['wrap.near'::text] AND (token_id LIKE 'staking:%' OR token_id = 'near')))",
            param_index
        ));
        param_index += 1;
    } else if filters.exclude_token_ids.is_some() {
        conditions.push(format!(
            "(token_id != ALL(${0}) AND NOT (token_id LIKE ANY(ARRAY(SELECT '%:' || unnest(${0})))) AND NOT (${0} @> ARRAY['wrap.near'::text] AND (token_id LIKE 'staking:%' OR token_id = 'near')))",
            param_index
        ));
        param_index += 1;
    }

    // Transaction Type Filter (can select multiple: incoming, outgoing, staking_rewards, exchange)
    if let Some(ref types) = filters.transaction_types
        && !types.is_empty()
        && !types.contains(&"all".to_string())
    {
        let mut type_conditions = Vec::new();

        for t in types {
            match t.as_str() {
                "incoming" => {
                    if filters.exclude_swaps_from_direction {
                        // Recent activity: exclude swaps (they have separate tab)
                        // For incoming (amount > 0), only check fulfillment_balance_change_id (the receive leg)
                        type_conditions.push(
                            "(amount > 0 AND counterparty != 'STAKING_REWARD' \
                             AND NOT EXISTS (SELECT 1 FROM detected_swaps \
                                WHERE account_id = $1 \
                                  AND fulfillment_balance_change_id = balance_changes.id))"
                                .to_string(),
                        );
                    } else {
                        // Export/API: include swaps in incoming
                        type_conditions
                            .push("(amount > 0 AND counterparty != 'STAKING_REWARD')".to_string());
                    }
                }
                "outgoing" => {
                    if filters.exclude_swaps_from_direction {
                        // Recent activity: exclude swaps (they have separate tab)
                        // For outgoing (amount < 0), only check deposit_balance_change_id (the send leg)
                        type_conditions.push(
                            "(amount < 0 AND NOT EXISTS (SELECT 1 FROM detected_swaps \
                                WHERE account_id = $1 \
                                  AND deposit_balance_change_id = balance_changes.id))"
                                .to_string(),
                        );
                    } else {
                        // Export/API: include swaps in outgoing
                        type_conditions.push("amount < 0".to_string());
                    }
                }
                "staking_rewards" => {
                    type_conditions.push("counterparty = 'STAKING_REWARD'".to_string())
                }
                "exchange" => {
                    // Check if this balance change is part of a detected swap
                    type_conditions.push(
                        "EXISTS (SELECT 1 FROM detected_swaps \
                            WHERE account_id = $1 \
                              AND (fulfillment_balance_change_id = balance_changes.id \
                                   OR deposit_balance_change_id = balance_changes.id))"
                            .to_string(),
                    );
                }
                _ => {} // Invalid - ignore
            }
        }

        if !type_conditions.is_empty() {
            conditions.push(format!("({})", type_conditions.join(" OR ")));
        }
    }

    // Exclude native NEAR "proposal-deposit-" entries from recent-activity.
    // These are NEAR→wNEAR conversion side-effects, not the actual swap deposit.
    if filters.exclude_swaps_from_direction {
        conditions.push(
            "NOT (balance_changes.token_id = 'near' \
                AND EXISTS (SELECT 1 FROM detected_swaps \
                    WHERE account_id = $1 \
                      AND deposit_balance_change_id = balance_changes.id \
                      AND solver_transaction_hash LIKE 'proposal-deposit-%'))"
                .to_string(),
        );
    }

    // Min Amount Filter (absolute value, decimal-adjusted)
    if filters.min_amount.is_some() {
        conditions.push(format!("ABS(amount) >= ${}", param_index));
        param_index += 1;
    }

    // Max Amount Filter (absolute value, decimal-adjusted)
    if filters.max_amount.is_some() {
        conditions.push(format!("ABS(amount) <= ${}", param_index));
        param_index += 1;
    }

    // Transaction hash query (partial match)
    if filters.transaction_hash_query.is_some() {
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM unnest(transaction_hashes) AS tx_hash WHERE tx_hash ILIKE ${})",
            param_index
        ));
        param_index += 1;
    }

    // "From" filter:
    // - Incoming rows: counterparty (unless UNKNOWN), fallback to signer_id
    // - Outgoing rows: account_id (DAO)
    if filters.from_accounts.is_some() {
        conditions.push(format!("({}) = ANY(${})", FROM_ACCOUNT_EXPR, param_index));
        param_index += 1;
    }
    if filters.from_accounts_not.is_some() {
        conditions.push(format!(
            "(({}) IS NULL OR NOT (({}) = ANY(${})))",
            FROM_ACCOUNT_EXPR, FROM_ACCOUNT_EXPR, param_index
        ));
        param_index += 1;
    }
    if filters.to_accounts.is_some() {
        conditions.push(format!("({}) = ANY(${})", TO_ACCOUNT_EXPR, param_index));
        param_index += 1;
    }
    if filters.to_accounts_not.is_some() {
        conditions.push(format!(
            "(({}) IS NULL OR NOT (({}) = ANY(${})))",
            TO_ACCOUNT_EXPR, TO_ACCOUNT_EXPR, param_index
        ));
        param_index += 1;
    }

    // Exclude tiny NEAR amounts (gas/storage noise)
    if filters.exclude_near_dust {
        conditions.push("NOT (token_id = 'near' AND ABS(amount) < 0.09)".to_string());
    }

    (conditions, param_index)
}

/// Builds a COUNT query for balance changes
pub fn build_count_query(filters: &BalanceChangeFilters) -> String {
    let (conditions, _) = build_where_conditions(filters);
    let where_clause = conditions.join(" AND ");

    format!(
        "SELECT COUNT(*) FROM balance_changes WHERE {}",
        where_clause
    )
}

/// Builds a SELECT query for balance changes with pagination
pub fn build_select_query(
    filters: &BalanceChangeFilters,
    select_fields: &str,
    order_by: &str,
    with_pagination: bool,
) -> (String, usize) {
    let (conditions, mut param_index) = build_where_conditions(filters);
    let where_clause = conditions.join(" AND ");

    let mut query = format!(
        "SELECT {} FROM balance_changes WHERE {} ORDER BY {}",
        select_fields, where_clause, order_by
    );

    if with_pagination {
        query.push_str(&format!(
            " LIMIT ${} OFFSET ${}",
            param_index,
            param_index + 1
        ));
        param_index += 2;
    }

    (query, param_index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_where_conditions_basic() {
        let filters = BalanceChangeFilters {
            account_id: "test.near".parse().unwrap(),
            date_cutoff: None,
            start_date: None,
            end_date: None,
            token_ids: None,
            exclude_token_ids: None,
            transaction_types: None,
            min_amount: None,
            max_amount: None,
            transaction_hash_query: None,
            from_accounts: None,
            from_accounts_not: None,
            to_accounts: None,
            to_accounts_not: None,
            exclude_near_dust: false,
            exclude_swaps_from_direction: false,
        };

        let (conditions, param_index) = build_where_conditions(&filters);

        assert_eq!(conditions.len(), 7); // Base conditions: account_id, SNAPSHOT, STAKING_SNAPSHOT, NOT_REGISTERED, zero-change, CreateAccount, relayer
        assert_eq!(param_index, 2);
    }

    #[test]
    fn test_build_where_conditions_with_filters() {
        let filters = BalanceChangeFilters {
            account_id: "test.near".parse().unwrap(),
            date_cutoff: Some(Utc::now()),
            start_date: None,
            end_date: None,
            token_ids: Some(vec!["usdt.near".to_string()]),
            exclude_token_ids: None,
            transaction_types: Some(vec!["outgoing".to_string()]),
            min_amount: None,
            max_amount: None,
            transaction_hash_query: None,
            from_accounts: None,
            from_accounts_not: None,
            to_accounts: None,
            to_accounts_not: None,
            exclude_near_dust: false,
            exclude_swaps_from_direction: false,
        };

        let (conditions, param_index) = build_where_conditions(&filters);

        assert_eq!(conditions.len(), 10); // Base (7) + date (1) + token (1) + txn_type (1)
        assert_eq!(param_index, 4); // 1 (account_id) + 1 (date) + 1 (tokens) + starts at 2
        assert!(conditions.contains(&"block_time >= $2".to_string()));
        assert!(conditions.iter().any(|c| c.contains("token_id = ANY($3)")));
        assert!(conditions.iter().any(|c| c.contains("amount < 0")));
    }
}
