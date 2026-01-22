-- Create bulk_payment_requests table for tracking bulk payment usage
CREATE TABLE bulk_payment_requests (
    id SERIAL PRIMARY KEY,
    treasury_id VARCHAR(255) NOT NULL,
    list_id VARCHAR(255) NOT NULL UNIQUE,
    recipient_count INTEGER NOT NULL,
    token_id VARCHAR(255) NOT NULL,
    total_amount VARCHAR(78) NOT NULL,
    proposal_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NOT NULL
);

-- Indexes for performance
CREATE INDEX idx_bulk_payment_treasury ON bulk_payment_requests(treasury_id);
CREATE INDEX idx_bulk_payment_created_at ON bulk_payment_requests(created_at DESC);

-- Comments for documentation
COMMENT ON TABLE bulk_payment_requests IS 'Tracks bulk payment requests created through the UI for usage statistics';
COMMENT ON COLUMN bulk_payment_requests.treasury_id IS 'DAO contract ID that owns this bulk payment request';
COMMENT ON COLUMN bulk_payment_requests.list_id IS 'Unique hash identifier for the payment list (SHA-256)';
COMMENT ON COLUMN bulk_payment_requests.recipient_count IS 'Number of recipients in this bulk payment request';
COMMENT ON COLUMN bulk_payment_requests.token_id IS 'Token used for payment (native, contract address, or nep141:address)';
COMMENT ON COLUMN bulk_payment_requests.total_amount IS 'Total amount being paid (stored as string to preserve precision)';
COMMENT ON COLUMN bulk_payment_requests.proposal_id IS 'Associated DAO proposal ID';
COMMENT ON COLUMN bulk_payment_requests.created_by IS 'Account ID that created the request';

