//! Token-id matching for the gold ledger readers.
//!
//! Symbol search (`?tokenSymbol=usdc`) resolves plain NEAR contract ids such as
//! `eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near`, but the gold
//! ledger stores intents assets in defuse form (`nep141:<contract>`, and legacy
//! `balance_changes` rows use `intents.near:nep141:<contract>`). Comparing the
//! two with plain equality silently matches nothing, so every token column
//! comparison goes through here and also tests the column with any `…:` prefix
//! stripped.

use sqlx::{Postgres, QueryBuilder};

/// Push `(<col> = ANY($tokens) OR <bare col> = ANY($tokens) OR …)` for each
/// column, so a filter matches whether the row stores the bare contract id or a
/// defuse-prefixed one.
///
/// Columns are static SQL identifiers supplied by the callers in this crate;
/// only the token list is bound.
pub fn push_token_match<'a>(
    builder: &mut QueryBuilder<'a, Postgres>,
    columns: &[&str],
    tokens: &[String],
) {
    builder.push("(");
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            builder.push(" OR ");
        }
        builder.push(column);
        builder.push(" = ANY(");
        builder.push_bind(tokens.to_vec());
        builder.push(") OR regexp_replace(");
        builder.push(column);
        builder.push(", '^.*:', '') = ANY(");
        builder.push_bind(tokens.to_vec());
        builder.push(")");
    }
    builder.push(")");
}

#[cfg(test)]
mod tests {
    use super::push_token_match;
    use sqlx::{Postgres, QueryBuilder};

    #[test]
    fn matches_bare_and_prefixed_ids() {
        let mut builder = QueryBuilder::<Postgres>::new("SELECT 1 WHERE ");
        push_token_match(&mut builder, &["leg_token_id"], &["wrap.near".to_string()]);
        let sql = builder.into_sql();

        assert!(sql.contains("leg_token_id = ANY($1)"));
        assert!(sql.contains("regexp_replace(leg_token_id, '^.*:', '') = ANY($2)"));
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
        assert_eq!(sql.matches("regexp_replace(").count(), 2);
    }
}
