-- Version Terms acceptance columns:
-- - terms_accepted_at -> v1_terms_accepted_at
-- - add v2_terms_accepted_at for renewed acceptance
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'terms_accepted_at'
    ) THEN
        ALTER TABLE users
            RENAME COLUMN terms_accepted_at TO v1_terms_accepted_at;
    END IF;
END $$;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS v2_terms_accepted_at TIMESTAMPTZ;

-- Rebuild views so activation tracks latest accepted terms (v2).
DROP VIEW IF EXISTS "onboarded_daos";

CREATE OR REPLACE VIEW "onboarded_daos" AS
SELECT DISTINCT ON (dm.dao_id)
    dm.dao_id,
    ma.enabled AS ma_enabled,
    ma.plan_type AS ma_plan_type,
    ma.credits_reset_at AS ma_credits_reset_at,
    ma.export_credits AS ma_export_credits,
    ma.batch_payment_credits AS ma_batch_payment_credits,
    ma.gas_covered_transactions AS ma_gas_covered_transactions,
    ma.paid_near AS ma_paid_near,
    ma.created_at AS created_at,
    ma.created_by_trezu_at AS ma_created_by_trezu_at,
    ma.from_near_treasury AS ma_from_near_treasury,
    (
        SELECT COUNT(DISTINCT dm2.account_id)
        FROM dao_members dm2
        JOIN users u2 ON u2.account_id = dm2.account_id
            AND dm2.is_policy_member = true
        WHERE dm2.dao_id = dm.dao_id
          AND u2.v2_terms_accepted_at IS NOT NULL
    ) AS activated_members,
    (
        SELECT COUNT(DISTINCT dm3.account_id)
        FROM dao_members dm3
        WHERE dm3.dao_id = dm.dao_id
          AND dm3.is_policy_member = true
    ) AS total_members
FROM users u
JOIN dao_members dm ON dm.account_id = u.account_id
LEFT JOIN monitored_accounts ma ON ma.account_id = dm.dao_id
WHERE u.v2_terms_accepted_at IS NOT NULL
ORDER BY dm.dao_id;

DROP VIEW IF EXISTS "near_treasury_daos_activation";

CREATE OR REPLACE VIEW "near_treasury_daos_activation" AS
SELECT
    ma.account_id,
    (EXISTS (
        SELECT 1 FROM dao_members dm
        JOIN users u ON u.account_id = dm.account_id
        WHERE dm.dao_id = ma.account_id
          AND u.v2_terms_accepted_at IS NOT NULL
    )) AS is_activated,
    COALESCE(ut.tx_amount, 0) AS tx_amount,
    COUNT(DISTINCT dm_activated.account_id) AS activated_members,
    COUNT(DISTINCT dm_all.account_id) AS total_members
FROM monitored_accounts ma
LEFT JOIN (
    SELECT monitored_account_id, SUM(gas_covered_transactions) AS tx_amount
    FROM usage_tracking
    GROUP BY monitored_account_id
) ut ON ut.monitored_account_id = ma.account_id
LEFT JOIN dao_members dm_all ON dm_all.dao_id = ma.account_id AND dm_all.is_policy_member = true
LEFT JOIN dao_members dm_activated
    ON dm_activated.dao_id = ma.account_id AND dm_activated.is_policy_member = true
    AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.account_id = dm_activated.account_id
          AND u.v2_terms_accepted_at IS NOT NULL
    )
WHERE ma.from_near_treasury = true
GROUP BY ma.account_id, ut.tx_amount;
