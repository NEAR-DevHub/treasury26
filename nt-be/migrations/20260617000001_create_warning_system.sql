CREATE TABLE warning_slots (
    id SERIAL PRIMARY KEY,
    slot TEXT,
    token TEXT,
    network TEXT,
    is_active BOOLEAN NOT NULL DEFAULT false,
    response TEXT NOT NULL DEFAULT 'notice' CHECK (
        response IN ('notice', 'paused')
    ),
    severity TEXT NOT NULL DEFAULT 'high' CHECK (
        severity IN ('low', 'high', 'critical')
    ),
    user_message TEXT,
    situation TEXT,
    internal_note TEXT,
    show_from TIMESTAMPTZ,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    linked_service TEXT,
    linked_post_id TEXT,
    group_id TEXT,
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

CREATE INDEX idx_warning_slots_scheduled ON warning_slots (show_from)
WHERE
    show_from IS NOT NULL;

CREATE INDEX idx_warning_slots_group ON warning_slots (group_id)
WHERE
    group_id IS NOT NULL;

CREATE INDEX idx_warning_slots_linked_service_active ON warning_slots (linked_service)
WHERE
    linked_service IS NOT NULL
    AND is_active = true;

CREATE INDEX idx_warning_audit_log_created_at ON warning_audit_log (created_at DESC);
