-- Local display names (override NEAR Social profile names when set).
CREATE TABLE user_profiles (
    account_id   VARCHAR(64) PRIMARY KEY,
    display_name TEXT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_user_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_user_profiles_updated_at();

-- One-time invite links for joining a treasury via ChangePolicy approval.
CREATE TABLE member_invite_links (
    token               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dao_id              VARCHAR(128) NOT NULL REFERENCES monitored_accounts(account_id) ON DELETE CASCADE,
    created_by          UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    used_at             TIMESTAMPTZ NULL,
    used_by_account_id  VARCHAR(64) NULL
);

CREATE INDEX idx_member_invite_links_dao_id ON member_invite_links(dao_id);

-- Pending join requests created when an invite link is consumed.
CREATE TABLE member_join_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dao_id       VARCHAR(128) NOT NULL REFERENCES monitored_accounts(account_id) ON DELETE CASCADE,
    account_id   VARCHAR(64) NOT NULL,
    invite_token UUID NOT NULL UNIQUE REFERENCES member_invite_links(token),
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'cancelled')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_member_join_requests_pending_dao_account
    ON member_join_requests(dao_id, account_id)
    WHERE status = 'pending';

CREATE INDEX idx_member_join_requests_dao_status
    ON member_join_requests(dao_id, status);

CREATE OR REPLACE FUNCTION update_member_join_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER member_join_requests_updated_at
    BEFORE UPDATE ON member_join_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_member_join_requests_updated_at();
