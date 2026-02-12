-- Create export_history table for tracking transaction exports
CREATE TABLE IF NOT EXISTS export_history (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(256) NOT NULL,
    generated_by VARCHAR(256) NOT NULL, -- User who requested the export
    email VARCHAR(256), -- Email for notifications (optional)
    status VARCHAR(20) NOT NULL DEFAULT 'completed', -- completed, failed
    file_url TEXT NOT NULL, -- URL with all export parameters
    error_message TEXT, -- Error message if failed
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_export_history_account_id ON export_history(account_id);
CREATE INDEX IF NOT EXISTS idx_export_history_generated_by ON export_history(generated_by);

-- Add comments
COMMENT ON TABLE export_history IS 'Stores history of transaction exports requested by users';
COMMENT ON COLUMN export_history.account_id IS 'Treasury/DAO account ID that was exported';
COMMENT ON COLUMN export_history.generated_by IS 'User account ID who requested the export';
COMMENT ON COLUMN export_history.email IS 'Email address for export notifications';
COMMENT ON COLUMN export_history.status IS 'Export status: completed, failed';
COMMENT ON COLUMN export_history.file_url IS 'Download URL with all export parameters (date range, filters, format)';
COMMENT ON COLUMN export_history.error_message IS 'Error details if export failed';
COMMENT ON COLUMN export_history.created_at IS 'When the export was created/requested';

