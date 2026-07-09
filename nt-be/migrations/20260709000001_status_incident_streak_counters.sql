ALTER TABLE status_incidents
ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0,
ADD COLUMN consecutive_successes INTEGER NOT NULL DEFAULT 0;
