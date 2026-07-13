-- Explicit flag: when false, the app uses translated catalog copy;
-- when true, the app shows the stored user_message as-is.
ALTER TABLE warning_slots
    ADD COLUMN use_custom_message BOOLEAN NOT NULL DEFAULT false;
