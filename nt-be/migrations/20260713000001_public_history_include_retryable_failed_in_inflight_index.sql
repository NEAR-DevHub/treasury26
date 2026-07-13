-- Apalis can lock retryable Failed rows again (attempts < max_attempts).
-- The old public history inflight index ignored those rows, allowing the
-- scheduler to insert a duplicate Pending job for the same job_key. When
-- Apalis later retried the Failed row, its status update could collide with
-- the duplicate active row and stop the public-history worker.
--
-- On a brand-new database, sqlx migrations may run before apalis-postgres has
-- created apalis.jobs. In that case this migration intentionally no-ops; the
-- application startup setup creates the corrected index after Apalis storage is
-- initialized. Existing databases with apalis.jobs get the duplicate cleanup
-- and index replacement here.
DO $$
BEGIN
    IF to_regclass('apalis.jobs') IS NOT NULL THEN
        -- Exhaust only duplicate retryable Failed rows, then make the index
        -- match Apalis retry eligibility. Do not write an explanatory error
        -- column here: apalis.jobs column names differ across Apalis versions,
        -- and this migration must run against the table shape already present
        -- in staging/production.
        EXECUTE $sql$
            WITH ranked_public_history_jobs AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY job_type, metadata->>'job_key'
                        ORDER BY
                            CASE
                                WHEN status IN ('Pending', 'Queued', 'Running') THEN 0
                                ELSE 1
                            END,
                            run_at DESC,
                            id DESC
                    ) AS rank
                FROM apalis.jobs
                WHERE job_type IN ('public_history_latest', 'public_history_backfill')
                  AND metadata ? 'job_key'
                  AND (
                      status IN ('Pending', 'Queued', 'Running')
                      OR (status = 'Failed' AND attempts < max_attempts)
                  )
            )
            UPDATE apalis.jobs jobs
            SET
                attempts = jobs.max_attempts,
                done_at = COALESCE(jobs.done_at, NOW())
            FROM ranked_public_history_jobs ranked
            WHERE jobs.id = ranked.id
              AND ranked.rank > 1
              AND jobs.status = 'Failed'
              AND jobs.attempts < jobs.max_attempts
        $sql$;

        EXECUTE 'DROP INDEX IF EXISTS apalis.idx_public_history_jobs_inflight_key';

        EXECUTE $sql$
            CREATE UNIQUE INDEX idx_public_history_jobs_inflight_key
            ON apalis.jobs (job_type, ((metadata->>'job_key')))
            WHERE job_type IN ('public_history_latest', 'public_history_backfill')
              AND (
                  status IN ('Pending', 'Queued', 'Running')
                  OR (status = 'Failed' AND attempts < max_attempts)
              )
              AND metadata ? 'job_key'
        $sql$;
    END IF;
END $$;
