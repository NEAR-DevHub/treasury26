use std::collections::HashSet;

use sqlx::PgPool;

/// Decide whether a DAO should be flagged as testing.
///
/// Rules:
/// - Explicit testing DAO IDs always match.
/// - Otherwise, members must be non-empty and all members must be in the
///   testing account allowlist.
pub fn should_mark_testing(
    dao_id: &str,
    members: &HashSet<String>,
    testing_sputnik_dao_ids: &HashSet<String>,
    testing_near_account_ids: &HashSet<String>,
) -> bool {
    if testing_sputnik_dao_ids.contains(dao_id) {
        return true;
    }

    !members.is_empty()
        && members
            .iter()
            .all(|member| testing_near_account_ids.contains(member))
}

/// Mark a tracked DAO as testing when `should_mark` is true.
///
/// Returns the persisted value from `monitored_accounts.is_testing`.
pub async fn mark_testing_if_needed(
    pool: &PgPool,
    dao_id: &str,
    should_mark: bool,
) -> Result<bool, sqlx::Error> {
    if should_mark {
        sqlx::query(
            r#"
            UPDATE monitored_accounts
            SET is_testing = true,
                updated_at = NOW()
            WHERE account_id = $1
              AND is_testing = false
            "#,
        )
        .bind(dao_id)
        .execute(pool)
        .await?;
    }

    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT is_testing
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(dao_id)
    .fetch_optional(pool)
    .await
    .map(|value| value.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_dao_is_always_marked() {
        let members = HashSet::from(["alice.near".to_string()]);
        let dao_ids = HashSet::from(["treasury.sputnik-dao.near".to_string()]);
        let near_ids = HashSet::new();

        assert!(should_mark_testing(
            "treasury.sputnik-dao.near",
            &members,
            &dao_ids,
            &near_ids
        ));
    }

    #[test]
    fn all_members_in_testing_set_marks_dao() {
        let members = HashSet::from(["alice.near".to_string(), "bob.near".to_string()]);
        let dao_ids = HashSet::new();
        let near_ids = HashSet::from(["alice.near".to_string(), "bob.near".to_string()]);

        assert!(should_mark_testing(
            "treasury.sputnik-dao.near",
            &members,
            &dao_ids,
            &near_ids
        ));
    }

    #[test]
    fn mixed_members_do_not_mark_dao() {
        let members = HashSet::from(["alice.near".to_string(), "real-user.near".to_string()]);
        let dao_ids = HashSet::new();
        let near_ids = HashSet::from(["alice.near".to_string()]);

        assert!(!should_mark_testing(
            "treasury.sputnik-dao.near",
            &members,
            &dao_ids,
            &near_ids
        ));
    }

    #[test]
    fn empty_members_do_not_mark_dao_without_explicit_id() {
        let members = HashSet::new();
        let dao_ids = HashSet::new();
        let near_ids = HashSet::from(["alice.near".to_string()]);

        assert!(!should_mark_testing(
            "treasury.sputnik-dao.near",
            &members,
            &dao_ids,
            &near_ids
        ));
    }

    #[sqlx::test]
    async fn mark_testing_persists_and_returns_value(pool: PgPool) -> sqlx::Result<()> {
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id)
            VALUES ($1)
            "#,
        )
        .bind("treasury.sputnik-dao.near")
        .execute(&pool)
        .await?;

        let initial = mark_testing_if_needed(&pool, "treasury.sputnik-dao.near", false).await?;
        assert!(!initial, "DAO should start as non-testing");

        let marked = mark_testing_if_needed(&pool, "treasury.sputnik-dao.near", true).await?;
        assert!(marked, "DAO should be marked as testing");

        let still_marked =
            mark_testing_if_needed(&pool, "treasury.sputnik-dao.near", false).await?;
        assert!(still_marked, "Testing flag is sticky and remains true");

        Ok(())
    }
}
