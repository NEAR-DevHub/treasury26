ALTER TABLE usage_tracking
    ADD COLUMN IF NOT EXISTS address_book_payment_proposals INTEGER NOT NULL DEFAULT 0;
