pub mod admin;
pub mod admin_page;
pub mod db;
pub mod public;
pub mod templates;

pub const ACTIVE_WARNINGS_SQL: &str = r#"
    SELECT
        id,
        slot,
        token,
        network,
        response,
        severity,
        user_message,
        use_custom_message,
        situation,
        show_from,
        starts_at,
        ends_at
    FROM warning_slots
    WHERE (
        is_active = true
        OR (show_from IS NOT NULL AND show_from <= NOW())
    )
    AND (ends_at IS NULL OR ends_at > NOW())
    ORDER BY id
"#;

#[cfg(test)]
mod tests;
