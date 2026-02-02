-- Create users table for authentication and terms acceptance
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id VARCHAR(64) NOT NULL UNIQUE,
    terms_accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast account lookups
CREATE INDEX idx_users_account_id ON users(account_id);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_users_updated_at();

-- Table for storing auth challenges (nonces)
CREATE TABLE auth_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id VARCHAR(64) NOT NULL,
    nonce BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes')
);

-- Index for challenge lookups
CREATE INDEX idx_auth_challenges_account_id ON auth_challenges(account_id);
CREATE INDEX idx_auth_challenges_expires_at ON auth_challenges(expires_at);

-- Create user_sessions table for JWT token management
CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    -- SHA256 hash of the JWT
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ -- NULL if active, set when logged out
);

-- Index for token lookup
CREATE INDEX idx_user_sessions_token_hash ON user_sessions(token_hash);

-- Index for user's sessions
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);

-- Index for cleanup of expired sessions
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
