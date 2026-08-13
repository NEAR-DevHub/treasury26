-- Durable realtime refresh demands: the newest Goldsky trigger per
-- (account, source). Apalis rows become single-shot dispatch tokens; a
-- trigger arriving while a token is in flight bumps the generation instead
-- of being silently discarded, and the dispatcher re-tokens any demand whose
-- generation outlived its job.
CREATE TABLE public_history_latest_demands (
    account_id text NOT NULL,
    source public_history_source NOT NULL,
    trigger_block_height bigint NOT NULL,
    trigger_transaction_hash text,
    generation bigint NOT NULL DEFAULT 1,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, source)
);

CREATE INDEX idx_public_latest_demands_ready
    ON public_history_latest_demands (next_attempt_at);
