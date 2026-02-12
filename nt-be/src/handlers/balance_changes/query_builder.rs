use chrono::{DateTime, Utc};

/// Common parameters for filtering balance changes
#[derive(Debug, Clone)]
pub struct BalanceChangeFilters {
    pub account_id: String,

    // Date Filtering
    pub date_cutoff: Option<DateTime<Utc>>, // Minimum date (for plan limits)
    pub start_date: Option<DateTime<Utc>>,  // Custom start date filter
    pub end_date: Option<DateTime<Utc>>,    // Custom end date filter

    // Token Filtering (Whitelist OR Blacklist)
    pub token_ids: Option<Vec<String>>, // Include ONLY these
    pub exclude_token_ids: Option<Vec<String>>, // Exclude these

    // Transaction Type Filtering (can select multiple)
    // "incoming" = received payments (amount > 0, includes staking rewards)
    // "outgoing" = sent payments (amount < 0)
    // "staking_rewards" = staking rewards only (counterparty = 'STAKING_REWARD')
    pub transaction_types: Option<Vec<String>>,

    // Amount Filtering
    pub min_amount: Option<f64>, // Absolute value, decimal-adjusted
    pub max_amount: Option<f64>, // Absolute value, decimal-adjusted
}

/// Builds WHERE clause conditions for balance changes queries
pub fn build_where_conditions(filters: &BalanceChangeFilters) -> (Vec<String>, usize) {
    let mut conditions = vec![
        "account_id = $1".to_string(),
        "counterparty != 'SNAPSHOT'".to_string(),
        "counterparty != 'STAKING_SNAPSHOT'".to_string(),
        "counterparty != 'NOT_REGISTERED'".to_string(),
        "token_id != 'near:total'".to_string(), // Exclude internal aggregate token
        // Exclude swap deposit legs - these are shown as part of the swap fulfillment
        format!(
            "id NOT IN (SELECT deposit_balance_change_id FROM detected_swaps WHERE account_id = $1 AND deposit_balance_change_id IS NOT NULL)"
        ),
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

    // Transaction Type Filter (can select multiple: incoming, outgoing, staking_rewards)
    if let Some(ref types) = filters.transaction_types
        && !types.is_empty()
        && !types.contains(&"all".to_string())
    {
        let mut type_conditions = Vec::new();

        for t in types {
            match t.as_str() {
                "incoming" => type_conditions.push("amount > 0".to_string()),
                "outgoing" => type_conditions.push("amount < 0".to_string()),
                "staking_rewards" => {
                    type_conditions.push("counterparty = 'STAKING_REWARD'".to_string())
                }
                _ => {} // Invalid - ignore
            }
        }

        if !type_conditions.is_empty() {
            conditions.push(format!("({})", type_conditions.join(" OR ")));
        }
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
            account_id: "test.near".to_string(),
            date_cutoff: None,
            start_date: None,
            end_date: None,
            token_ids: None,
            exclude_token_ids: None,
            transaction_types: None,
            min_amount: None,
            max_amount: None,
        };

        let (conditions, param_index) = build_where_conditions(&filters);

        assert_eq!(conditions.len(), 6); // Base conditions: account_id, 3x counterparty filters, near:total filter, swap deposit exclusion subquery
        assert_eq!(param_index, 2);
    }

    #[test]
    fn test_build_where_conditions_with_filters() {
        let filters = BalanceChangeFilters {
            account_id: "test.near".to_string(),
            date_cutoff: Some(Utc::now()),
            start_date: None,
            end_date: None,
            token_ids: Some(vec!["usdt.near".to_string()]),
            exclude_token_ids: None,
            transaction_types: Some(vec!["outgoing".to_string()]),
            min_amount: None,
            max_amount: None,
        };

        let (conditions, param_index) = build_where_conditions(&filters);

        assert_eq!(conditions.len(), 9); // Base (6) + date (1) + token (1) + txn_type (1)
        assert_eq!(param_index, 4); // 1 (account_id) + 1 (date) + 1 (tokens) + starts at 2
        assert!(conditions.contains(&"block_time >= $2".to_string()));
        assert!(conditions.iter().any(|c| c.contains("token_id = ANY($3)")));
        assert!(conditions.iter().any(|c| c.contains("amount < 0")));
    }
}
