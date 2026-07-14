-- Points the historical backfill asked DefiLlama for but got no data back
-- (within the search width). The backfill anti-joins this so permanently
-- missing points are not refetched forever; a point is retried on later runs
-- until `attempts` reaches the backfill's cap.
CREATE TABLE token_price_backfill_misses (
    token_ref       INTEGER NOT NULL REFERENCES tokens (id),
    minute_at       TIMESTAMPTZ NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 1,
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (token_ref, minute_at)
);