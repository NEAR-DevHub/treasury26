-- Persist treasury creation intent so a background sweeper can resume/finish
-- any creation that failed part-way (e.g. RPC timeout after the DAO was created
-- but before confidential ownership handoff). The intended policy (members +
-- thresholds) is NOT recoverable from chain for a half-created confidential
-- DAO, so we store the original request here.

-- Lifecycle of a creation request:
-- 'in_progress' → an attempt is actively running; sweeper leaves it alone
--                 until it goes stale (crash/restart safety net).
-- 'pending'     → attempt failed part-way; eligible for sweeping right away.
-- 'failed'      → terminal (too many attempts, or unrecoverable); needs a human.
-- Rows are DELETED on success, so the table only holds unfinished creations.
CREATE TYPE treasury_creation_status AS ENUM ('in_progress', 'pending', 'failed');

CREATE TABLE incomplete_treasury_creations (
    account_id           TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    payment_threshold    SMALLINT NOT NULL,
    governance_threshold SMALLINT NOT NULL,
    governors            TEXT[] NOT NULL,
    financiers           TEXT[] NOT NULL,
    requestors           TEXT[] NOT NULL,
    is_confidential      BOOLEAN NOT NULL DEFAULT false,
    status               treasury_creation_status NOT NULL DEFAULT 'in_progress',
    attempts             INTEGER NOT NULL DEFAULT 0,
    last_error           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The sweeper scans active (resumable) rows ordered by updated_at.
CREATE INDEX idx_incomplete_treasury_creations_active
    ON incomplete_treasury_creations (updated_at)
    WHERE status IN ('pending', 'in_progress');
