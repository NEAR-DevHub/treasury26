-- Opt-in flag for the custom-proposal-templates feature ("Custom Requests").
-- The feature ships disabled for every treasury; a DAO turns it on from Settings → Developer
-- (gated on the same on-chain ChangePolicy permission as authoring a template). Stored on
-- monitored_accounts because that is the per-treasury record proposal_templates already FKs to.
ALTER TABLE monitored_accounts
    ADD COLUMN custom_requests_enabled BOOLEAN NOT NULL DEFAULT false;
