-- Lets an operator stop the public-history bronze pipeline for one DAO
-- (whose backfill volume is disproportionate) without touching anything
-- else the DAO uses: proposal refresh, DAO policy sync, balance-monitor
-- maintenance, verification, and confidential monitoring all keep working
-- off `monitored_accounts.enabled`, which stays untouched.
--
-- history_ingestion_paused_at: NULL = active. Non-NULL stops all bronze
-- dispatch (latest/backfill/readiness) for the account until cleared.
--
-- backfill_capped / capped_at_block_height / capped_at_time: set together
-- with backfill_done=true when an operator clamps the account to the
-- current chain head instead of letting it walk to genesis. Distinguishes
-- an intentional cap (coverage starts at capped_at_block_height, not at
-- account creation) from a genuine completed walk. Readers that report
-- ledger coverage or verify running-balance invariants MUST scope to rows
-- at/after the cap for a capped account — everything retained from before
-- the cap is unreconciled history kept for display only, not a trustworthy
-- base for verification or "data since" claims.
ALTER TABLE monitored_accounts
    ADD COLUMN history_ingestion_paused_at TIMESTAMPTZ;

ALTER TABLE bronze_public_history_cursors
    ADD COLUMN backfill_capped BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN capped_at_block_height BIGINT,
    ADD COLUMN capped_at_time TIMESTAMPTZ,
    ADD CONSTRAINT bronze_capped_implies_done
        CHECK (NOT backfill_capped OR backfill_done),
    ADD CONSTRAINT bronze_capped_state_consistent
        CHECK (
            (capped_at_block_height IS NULL) = (capped_at_time IS NULL)
            AND backfill_capped = (capped_at_block_height IS NOT NULL)
        );
