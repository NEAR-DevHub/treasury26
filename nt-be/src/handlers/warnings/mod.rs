pub mod admin;
pub mod admin_page;
pub mod public;
pub mod templates;

pub const ACTIVE_WARNINGS_SQL: &str = r#"
    SELECT
        id,
        slot,
        token,
        network,
        severity,
        user_message,
        scheduled_start,
        scheduled_end
    FROM warning_slots
    WHERE (
        is_active = true
        OR (scheduled_start IS NOT NULL AND scheduled_start <= NOW())
    )
    AND (scheduled_end IS NULL OR scheduled_end > NOW())
    ORDER BY id
"#;

#[cfg(test)]
mod tests;
