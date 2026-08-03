-- Local overrides for treasury branding (name, logo, primary color).
-- When a row exists, these fields take precedence over on-chain get_config.
CREATE TABLE treasury_settings (
    account_id    TEXT PRIMARY KEY
                  REFERENCES monitored_accounts(account_id) ON DELETE CASCADE,
    display_name  TEXT NULL,
    flag_logo     TEXT NULL,
    primary_color TEXT NULL,
    updated_by    TEXT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_treasury_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER treasury_settings_updated_at
    BEFORE UPDATE ON treasury_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_treasury_settings_updated_at();
