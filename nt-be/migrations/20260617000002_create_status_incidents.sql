CREATE TABLE status_incidents (
    id SERIAL PRIMARY KEY,
    service TEXT NOT NULL,
    check_name TEXT NOT NULL,
    status TEXT NOT NULL,
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recovered_at TIMESTAMPTZ,
    telegram_message_id INTEGER,
    fallback_activated_at TIMESTAMPTZ,
    warning_slot_id INTEGER REFERENCES warning_slots (id) ON DELETE SET NULL,
    UNIQUE (service, check_name)
);

CREATE INDEX idx_status_incidents_active ON status_incidents (service)
WHERE
    recovered_at IS NULL;