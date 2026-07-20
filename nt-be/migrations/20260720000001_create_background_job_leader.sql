CREATE TABLE IF NOT EXISTS background_job_leader (
    lock_name TEXT PRIMARY KEY,
    instance_id UUID NOT NULL,
    generation BIGINT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ
);
