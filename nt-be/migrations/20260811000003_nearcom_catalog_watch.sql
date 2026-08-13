-- Tracks the last-seen GitHub blob SHA for near.com production.json so the
-- catalog-drift watcher can Telegram-notify once per upstream revision
-- (notify-only; no auto-sync into the vendored file).

CREATE TABLE nearcom_catalog_watch_state (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    upstream_sha    TEXT,
    last_notified_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error      TEXT
);

INSERT INTO nearcom_catalog_watch_state (id) VALUES (1);
