//! Match gold/legacy token columns against symbol-search contract ids.

use crate::services::oneclick_asset_routing::balance_asset_id_from_quote;
use sqlx::{Postgres, QueryBuilder};

/// Longest-first prefixes that unwrap to a bare FT contract.
const FT_PREFIXES: &[&str] = &[
    "nep245:intents.near:nep141:",
    "1cs_v1:near:nep141:",
    "intents.near:nep141:",
    "nep141:",
];

fn ft_storage_forms(bare: &str) -> Vec<String> {
    vec![
        bare.to_string(),
        format!("nep141:{bare}"),
        format!("intents.near:nep141:{bare}"),
        format!("1cs_v1:near:nep141:{bare}"),
    ]
}

fn bare_ft_contract_id(token: &str) -> Option<String> {
    let mapped = balance_asset_id_from_quote(token.trim());
    let without_1cs = mapped
        .strip_prefix("1cs_v1:")
        .and_then(|rest| rest.split_once(':').map(|(_, asset)| asset))
        .unwrap_or(mapped);
    for prefix in FT_PREFIXES {
        if let Some(bare) = without_1cs.strip_prefix(prefix) {
            return Some(bare.to_string());
        }
    }
    if without_1cs.contains(':') {
        None
    } else {
        Some(without_1cs.to_string())
    }
}

fn expand_token_match_ids(tokens: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(tokens.len() * 4);
    for token in tokens {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(bare) = bare_ft_contract_id(trimmed) {
            for form in ft_storage_forms(&bare) {
                if !out.iter().any(|existing| existing == &form) {
                    out.push(form);
                }
            }
        }
        if !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

/// `col = ANY($expanded)` for each column. `columns` are static SQL identifiers.
pub fn push_token_match<'a>(
    builder: &mut QueryBuilder<'a, Postgres>,
    columns: &[&str],
    tokens: &[String],
) {
    let expanded = expand_token_match_ids(tokens);
    builder.push("(");
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            builder.push(" OR ");
        }
        builder.push(column);
        builder.push(" = ANY(");
        builder.push_bind(expanded.clone());
        builder.push(")");
    }
    builder.push(")");
}

#[cfg(test)]
mod tests {
    use super::{expand_token_match_ids, push_token_match};
    use sqlx::{Postgres, QueryBuilder};

    fn wrap_forms() -> Vec<String> {
        vec![
            "wrap.near".to_string(),
            "nep141:wrap.near".to_string(),
            "intents.near:nep141:wrap.near".to_string(),
            "1cs_v1:near:nep141:wrap.near".to_string(),
        ]
    }

    #[test]
    fn expands_bare_id_with_known_prefixes() {
        assert_eq!(
            expand_token_match_ids(&["wrap.near".to_string()]),
            wrap_forms()
        );
    }

    #[test]
    fn expands_already_prefixed_ids() {
        let usdc = vec![
            "usdc.near".to_string(),
            "nep141:usdc.near".to_string(),
            "intents.near:nep141:usdc.near".to_string(),
            "1cs_v1:near:nep141:usdc.near".to_string(),
        ];
        assert_eq!(
            expand_token_match_ids(&["nep141:usdc.near".to_string()]),
            usdc
        );
        assert_eq!(
            expand_token_match_ids(&["intents.near:nep141:usdc.near".to_string()]),
            usdc
        );
    }

    #[test]
    fn fastnear_inbound_wrap_recovers_bare_contract() {
        assert_eq!(
            expand_token_match_ids(&["nep245:intents.near:nep141:eth.omft.near".to_string()]),
            vec![
                "eth.omft.near".to_string(),
                "nep141:eth.omft.near".to_string(),
                "intents.near:nep141:eth.omft.near".to_string(),
                "1cs_v1:near:nep141:eth.omft.near".to_string(),
                "nep245:intents.near:nep141:eth.omft.near".to_string(),
            ]
        );
    }

    #[test]
    fn maps_btc_native_1cs_to_nbtc_balance_forms() {
        let expanded = expand_token_match_ids(&["1cs_v1:btc:native:coin".to_string()]);
        assert!(expanded.contains(&"nbtc.bridge.near".to_string()));
        assert!(expanded.contains(&"nep141:nbtc.bridge.near".to_string()));
        assert!(expanded.contains(&"1cs_v1:btc:native:coin".to_string()));
    }

    #[test]
    fn leaves_hot_nep245_ids_unprefixed() {
        let hot = "nep245:v2_1.omni.hot.tg:43114_11111111111111111111";
        assert_eq!(
            expand_token_match_ids(&[hot.to_string()]),
            vec![hot.to_string()]
        );
    }

    #[test]
    fn matches_via_column_equality_not_regexp() {
        let mut builder = QueryBuilder::<Postgres>::new("SELECT 1 WHERE ");
        push_token_match(&mut builder, &["leg_token_id"], &["wrap.near".to_string()]);
        let sql = builder.into_sql();

        assert!(sql.contains("leg_token_id = ANY($1)"));
        assert!(!sql.contains("regexp_replace"));
    }

    #[test]
    fn ors_every_column() {
        let mut builder = QueryBuilder::<Postgres>::new("SELECT 1 WHERE ");
        push_token_match(
            &mut builder,
            &["token_in", "token_out"],
            &["wrap.near".to_string()],
        );
        let sql = builder.into_sql();

        assert!(sql.contains("token_in = ANY("));
        assert!(sql.contains("token_out = ANY("));
        assert_eq!(sql.matches(" = ANY(").count(), 2);
        assert!(!sql.contains("regexp_replace"));
    }
}
