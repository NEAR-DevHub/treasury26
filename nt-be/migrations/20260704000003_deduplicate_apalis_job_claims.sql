-- Avoid claiming multiple retriable rows with the same logical job key in one
-- Apalis fetch batch. The public history scheduler may see a new trigger while
-- a prior failed row is still retryable; claiming both at once violates the
-- inflight unique index when both are moved to Running.

CREATE OR REPLACE FUNCTION apalis.get_jobs(
    worker_id TEXT,
    v_job_type TEXT,
    v_job_count integer DEFAULT 5::integer
) RETURNS SETOF apalis.jobs AS $$
BEGIN
    RETURN QUERY
    WITH candidates AS MATERIALIZED (
        SELECT DISTINCT ON (job_type, job->>'job_key')
            id,
            priority,
            run_at
        FROM apalis.jobs
        WHERE (status = 'Pending' OR (status = 'Failed' AND attempts < max_attempts))
          AND run_at < now()
          AND job_type = v_job_type
        ORDER BY
            job_type,
            job->>'job_key',
            CASE WHEN status = 'Pending' THEN 0 ELSE 1 END,
            run_at ASC
    ),
    selected AS (
        SELECT j.id
        FROM apalis.jobs j
        JOIN candidates c ON c.id = j.id
        ORDER BY c.priority DESC, c.run_at ASC
        LIMIT v_job_count
        FOR UPDATE SKIP LOCKED
    )
    UPDATE apalis.jobs
    SET status = 'Running',
        lock_by = worker_id,
        lock_at = now()
    WHERE id IN (SELECT id FROM selected)
    RETURNING *;
END;
$$ LANGUAGE plpgsql VOLATILE;
