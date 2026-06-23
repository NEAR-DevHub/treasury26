CREATE TABLE warning_slots (
    id SERIAL PRIMARY KEY,
    slot TEXT,
    token TEXT,
    network TEXT,
    is_active BOOLEAN NOT NULL DEFAULT false,
    severity TEXT NOT NULL DEFAULT 'warning' CHECK (
        severity IN ('info', 'warning', 'critical')
    ),
    user_message TEXT,
    scenario TEXT,
    internal_note TEXT,
    scheduled_start TIMESTAMPTZ,
    scheduled_end TIMESTAMPTZ,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_warning_slots_unique ON warning_slots (
    COALESCE(slot, ''),
    COALESCE(token, ''),
    COALESCE(network, '')
);

CREATE TABLE warning_audit_log (
    id BIGSERIAL PRIMARY KEY,
    warning_id INTEGER REFERENCES warning_slots (id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (
        action IN (
            'created',
            'activated',
            'deactivated',
            'updated',
            'deleted',
            'scheduled'
        )
    ),
    changed_by TEXT NOT NULL,
    changes JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_warning_slots_active ON warning_slots (is_active)
WHERE
    is_active = true;

CREATE INDEX idx_warning_slots_scheduled ON warning_slots (scheduled_start)
WHERE
    scheduled_start IS NOT NULL;

CREATE INDEX idx_warning_audit_log_created_at ON warning_audit_log (created_at DESC);