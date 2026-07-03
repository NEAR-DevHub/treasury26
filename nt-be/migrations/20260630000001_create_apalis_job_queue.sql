-- App-owned Apalis PostgreSQL schema for apalis-sql 0.7.4.
--
-- Do not run PostgresStorage::migrations() at runtime: Apalis uses SQLx's
-- shared _sqlx_migrations table, which contaminates app migration history.

CREATE SCHEMA IF NOT EXISTS apalis;

CREATE TABLE IF NOT EXISTS apalis.workers (
    id TEXT NOT NULL,
    worker_type TEXT NOT NULL,
    storage_name TEXT NOT NULL,
    layers TEXT NOT NULL DEFAULT '',
    last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS Idx ON apalis.workers(id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_worker_id ON apalis.workers(id);
CREATE INDEX IF NOT EXISTS WTIdx ON apalis.workers(worker_type);
CREATE INDEX IF NOT EXISTS LSIdx ON apalis.workers(last_seen);

CREATE TABLE IF NOT EXISTS apalis.jobs (
    job JSONB NOT NULL,
    id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 25,
    run_at timestamptz NOT NULL DEFAULT now(),
    last_error TEXT,
    lock_at timestamptz,
    lock_by TEXT,
    done_at timestamptz,
    priority INTEGER DEFAULT 0,
    CONSTRAINT fk_worker_lock_by FOREIGN KEY(lock_by) REFERENCES apalis.workers(id)
);

CREATE INDEX IF NOT EXISTS TIdx ON apalis.jobs(id);
CREATE INDEX IF NOT EXISTS SIdx ON apalis.jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS unique_job_id ON apalis.jobs(id);
CREATE INDEX IF NOT EXISTS LIdx ON apalis.jobs(lock_by);
CREATE INDEX IF NOT EXISTS JTIdx ON apalis.jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_apalis_jobs_active_key
    ON apalis.jobs (job_type, ((job->>'job_key')))
    WHERE status IN ('Pending', 'Running', 'Failed');


CREATE OR REPLACE FUNCTION apalis.get_jobs(
    worker_id TEXT,
    v_job_type TEXT,
    v_job_count integer DEFAULT 5::integer
) RETURNS SETOF apalis.jobs AS $$
BEGIN
    RETURN QUERY
    UPDATE apalis.jobs
    SET status = 'Running',
        lock_by = worker_id,
        lock_at = now()
    WHERE id IN (
        SELECT id
        FROM apalis.jobs
        WHERE (status = 'Pending' OR (status = 'Failed' AND attempts < max_attempts))
          AND run_at < now()
          AND job_type = v_job_type
        ORDER BY priority DESC, run_at ASC
        LIMIT v_job_count
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION apalis.notify_new_jobs()
RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('apalis::job', 'insert');
    RETURN new;
END;
$$ LANGUAGE plpgsql;
