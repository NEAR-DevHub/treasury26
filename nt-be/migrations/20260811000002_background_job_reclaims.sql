CREATE TABLE IF NOT EXISTS background_job_reclaims (
    id BIGSERIAL PRIMARY KEY,
    job_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    from_status TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    lock_at TIMESTAMPTZ,
    reclaimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_background_job_reclaims_type_at
    ON background_job_reclaims (job_type, reclaimed_at DESC);

CREATE INDEX IF NOT EXISTS idx_background_job_reclaims_at
    ON background_job_reclaims (reclaimed_at);
