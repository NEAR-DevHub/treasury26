-- Whether a template is pinned to the sidebar. Pinning is a per-template, DAO-level flag (toggled
-- through the same ChangePolicy-gated update endpoint as the rest of a template's fields). The
-- sidebar shows only pinned templates under a collapsible chevron; unpinned ones live on the index.
ALTER TABLE proposal_templates
    ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;
