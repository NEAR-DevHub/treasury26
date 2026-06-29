-- Per-DAO custom proposal templates for the manifest-driven custom-proposal framework.
-- A `manifest` is a JSON form definition: a techy member authors it, regular members fill
-- the resulting form to file a generic SputnikDAO FunctionCall proposal. Storing manifests
-- off-chain (mirroring `address_book`) is safe: a manifest only defines a *form*; the proposal
-- it produces still passes the DAO's on-chain permissions and approvals.
CREATE TABLE proposal_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dao_id      VARCHAR(128) NOT NULL REFERENCES monitored_accounts(account_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NULL,
    manifest    JSONB NOT NULL,
    -- Slug derived from the manifest's own id, so the URL key (/custom-templates/<manifest_id>) and
    -- the [trezu-tmpl:<id>] provenance tag are the same identifier. GENERATED + STORED so it can
    -- never drift from the manifest; NOT NULL because every stored manifest has a validated id.
    manifest_id TEXT GENERATED ALWAYS AS (manifest->>'id') STORED NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One template name per DAO (human-facing identifier in the template list). Its leading
-- column also serves equality lookups on dao_id, so no separate dao_id index is needed.
CREATE UNIQUE INDEX uq_proposal_templates_dao_name ON proposal_templates(dao_id, name);
-- One manifest id per DAO: the slug must resolve to exactly one template, so
-- /custom-templates/<manifest_id> is unambiguous. Its leading dao_id column also serves
-- dao-scoped slug lookups, so no separate index is needed for the route.
CREATE UNIQUE INDEX uq_proposal_templates_dao_manifest_id ON proposal_templates(dao_id, manifest_id);
-- Indexed for FK-delete performance (ON DELETE SET NULL when a user is removed).
CREATE INDEX idx_proposal_templates_created_by ON proposal_templates(created_by);

-- Auto-update updated_at (same pattern as the `daos` table).
CREATE OR REPLACE FUNCTION update_proposal_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposal_templates_updated_at
    BEFORE UPDATE ON proposal_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_proposal_templates_updated_at();
