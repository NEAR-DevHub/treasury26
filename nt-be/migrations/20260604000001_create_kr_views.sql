-- KR/OKR dashboard views for NocoDB.

CREATE OR REPLACE VIEW kr__active_treasury_months AS
SELECT DISTINCT
    ut.billing_year,
    ut.billing_month,
    make_date(ut.billing_year, ut.billing_month, 1) AS month_start,
    ut.monitored_account_id
FROM usage_tracking ut
JOIN monitored_accounts ma
  ON ma.account_id = ut.monitored_account_id
 AND ma.is_testing IS NOT TRUE
WHERE (
    coalesce(ut.swap_proposals, 0)
  + coalesce(ut.payment_proposals, 0)
  + coalesce(ut.votes_casted, 0)
  + coalesce(ut.other_proposals_submitted, 0)
) > 0;

CREATE OR REPLACE VIEW kr__swap_receive_legs AS
SELECT
    bc.id AS balance_change_id,
    bc.block_time,
    bc.usd_value
FROM detected_swaps ds
JOIN balance_changes bc
  ON bc.id = ds.fulfillment_balance_change_id
JOIN monitored_accounts ma
  ON ma.account_id = ds.account_id
 AND ma.is_testing IS NOT TRUE
WHERE bc.usd_value IS NOT NULL;

CREATE OR REPLACE VIEW kr__payment_outflows AS
SELECT
    bc.id AS balance_change_id,
    bc.block_time,
    abs(bc.usd_value) AS usd_value
FROM balance_changes bc
JOIN monitored_accounts ma
  ON ma.account_id = bc.account_id
 AND ma.is_testing IS NOT TRUE
WHERE bc.amount < 0
  AND bc.usd_value IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM detected_swaps ds
      WHERE ds.deposit_balance_change_id = bc.id
  )
  AND NOT EXISTS (
      SELECT 1
      FROM monitored_accounts counterparty_ma
      WHERE counterparty_ma.account_id = bc.counterparty
        AND counterparty_ma.is_testing IS NOT TRUE
  );

--------------------------------------------------------------------------------
-- Scalar views for NocoDB number cards
--------------------------------------------------------------------------------

CREATE OR REPLACE VIEW kr_treasuries_created AS
SELECT count(*)::bigint AS total
FROM daos d
JOIN monitored_accounts ma
  ON ma.account_id = d.dao_id
 AND ma.is_testing IS NOT TRUE
WHERE d.sync_failed = false;

CREATE OR REPLACE VIEW kr_unique_wallets AS
SELECT count(*)::bigint AS total
FROM users
WHERE v2_terms_accepted_at IS NOT NULL;

CREATE OR REPLACE VIEW kr_mats AS
SELECT count(*)::bigint AS total
FROM kr__active_treasury_months
WHERE month_start = date_trunc('month', current_date)::date;

CREATE OR REPLACE VIEW kr_active_wallets AS
SELECT count(DISTINCT dm.account_id)::bigint AS total
FROM kr__active_treasury_months atm
JOIN dao_members dm
  ON dm.dao_id = atm.monitored_account_id
WHERE atm.month_start = date_trunc('month', current_date)::date;

CREATE OR REPLACE VIEW kr_aum_usd AS
WITH latest_snapshot AS (
    SELECT max(pddb.snapshot_date) AS snapshot_date
    FROM public_dashboard_daily_balances pddb
    JOIN monitored_accounts ma
      ON ma.account_id = pddb.dao_id
     AND ma.is_testing IS NOT TRUE
    WHERE pddb.is_trezu = true
)
SELECT coalesce(sum(pddb.total_usd), 0) AS aum_usd
FROM public_dashboard_daily_balances pddb
JOIN latest_snapshot ls
  ON ls.snapshot_date = pddb.snapshot_date
JOIN monitored_accounts ma
  ON ma.account_id = pddb.dao_id
 AND ma.is_testing IS NOT TRUE
WHERE pddb.is_trezu = true;

CREATE OR REPLACE VIEW kr_inflow_usd AS
SELECT coalesce(sum(bc.usd_value), 0) AS inflow_usd
FROM balance_changes bc
JOIN monitored_accounts ma
  ON ma.account_id = bc.account_id
 AND ma.is_testing IS NOT TRUE
WHERE bc.amount > 0
  AND bc.usd_value IS NOT NULL;

CREATE OR REPLACE VIEW kr_outflow_usd AS
SELECT coalesce(sum(usd_value), 0) AS outflow_usd
FROM kr__payment_outflows;

CREATE OR REPLACE VIEW kr_swap_volume_usd AS
SELECT coalesce(sum(usd_value), 0) AS swap_volume_usd
FROM kr__swap_receive_legs;

CREATE OR REPLACE VIEW kr_swap_fees_usd AS
SELECT (0.0035::numeric * coalesce(sum(usd_value), 0)) AS fees_usd
FROM kr__swap_receive_legs;

CREATE OR REPLACE VIEW kr_atv_usd AS
WITH ytd_volume AS (
    SELECT coalesce(sum(usd_value), 0) AS volume
    FROM kr__payment_outflows
    WHERE block_time >= date_trunc('year', current_date)

    UNION ALL

    SELECT coalesce(sum(usd_value), 0) AS volume
    FROM kr__swap_receive_legs
    WHERE block_time >= date_trunc('year', current_date)
)
SELECT (
    coalesce(sum(volume), 0)
    * 12.0
    / greatest(extract(month FROM current_date)::numeric, 1)
)::numeric AS atv_usd
FROM ytd_volume;

-- Time-series views for charts

CREATE OR REPLACE VIEW kr_aum_daily AS
SELECT
    pddb.snapshot_date,
    sum(pddb.total_usd) AS aum_usd
FROM public_dashboard_daily_balances pddb
JOIN monitored_accounts ma
  ON ma.account_id = pddb.dao_id
 AND ma.is_testing IS NOT TRUE
WHERE pddb.is_trezu = true
GROUP BY pddb.snapshot_date;

CREATE OR REPLACE VIEW kr_treasuries_created_daily AS
SELECT
    date_trunc('day', d.created_at)::date AS day,
    count(*)::bigint AS new_treasuries,
    sum(count(*)) OVER (
        ORDER BY date_trunc('day', d.created_at)::date
    )::bigint AS cumulative
FROM daos d
JOIN monitored_accounts ma
  ON ma.account_id = d.dao_id
 AND ma.is_testing IS NOT TRUE
WHERE d.sync_failed = false
GROUP BY 1;

CREATE OR REPLACE VIEW kr_unique_wallets_daily AS
SELECT
    date_trunc('day', v2_terms_accepted_at)::date AS day,
    count(*)::bigint AS new_wallets,
    sum(count(*)) OVER (
        ORDER BY date_trunc('day', v2_terms_accepted_at)::date
    )::bigint AS cumulative
FROM users
WHERE v2_terms_accepted_at IS NOT NULL
GROUP BY 1;

CREATE OR REPLACE VIEW kr_mats_monthly AS
SELECT
    billing_year,
    billing_month,
    month_start,
    count(*)::bigint AS mats
FROM kr__active_treasury_months
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW kr_treasury_churn_monthly AS
SELECT
    previous_month.billing_year,
    previous_month.billing_month,
    previous_month.month_start,
    count(*)::bigint AS previous_mats,
    count(*) FILTER (
        WHERE next_month.monitored_account_id IS NULL
    )::bigint AS churned_treasuries,
    (
        count(*) FILTER (
            WHERE next_month.monitored_account_id IS NULL
        )::numeric
        / nullif(count(*), 0)
    ) AS churn_rate
FROM kr__active_treasury_months previous_month
LEFT JOIN kr__active_treasury_months next_month
  ON next_month.monitored_account_id = previous_month.monitored_account_id
 AND next_month.month_start = (previous_month.month_start + interval '1 month')::date
WHERE previous_month.month_start < date_trunc('month', current_date)::date
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW kr_swap_volume_daily AS
SELECT
    date_trunc('day', block_time)::date AS day,
    sum(usd_value) AS swap_volume_usd
FROM kr__swap_receive_legs
GROUP BY 1;

CREATE OR REPLACE VIEW kr_outflow_daily AS
SELECT
    date_trunc('day', block_time)::date AS day,
    sum(usd_value) AS outflow_usd
FROM kr__payment_outflows
GROUP BY 1;

CREATE OR REPLACE VIEW kr_plan_distribution AS
SELECT
    coalesce(plan_type::text, 'unknown') AS plan_type,
    count(*)::bigint AS accounts
FROM monitored_accounts
WHERE is_testing IS NOT TRUE
GROUP BY 1;

-- Strategic dashboard grid

CREATE OR REPLACE VIEW kr_dashboard AS
SELECT
    1 AS sort_order,
    'User Acquisition'::text AS dimension,
    'Treasuries Created'::text AS metric,
    'Cumulative count of created treasuries.'::text AS definition,
    (SELECT total::text FROM kr_treasuries_created) AS current_value,
    (
        SELECT count(*)::text
        FROM daos d
        JOIN monitored_accounts ma
          ON ma.account_id = d.dao_id
         AND ma.is_testing IS NOT TRUE
        WHERE d.sync_failed = false
          AND d.created_at < date '2026-04-01'
    ) AS q1_act,
    (
        SELECT count(*)::text
        FROM daos d
        JOIN monitored_accounts ma
          ON ma.account_id = d.dao_id
         AND ma.is_testing IS NOT TRUE
        WHERE d.sync_failed = false
          AND d.created_at < date '2026-07-01'
    ) AS q2_act

UNION ALL

SELECT
    2,
    'User Acquisition',
    'Unique Wallets/Members Connected',
    'Cumulative count of users who accepted V2 terms.',
    (SELECT total::text FROM kr_unique_wallets),
    (
        SELECT count(*)::text
        FROM users
        WHERE v2_terms_accepted_at < date '2026-04-01'
    ),
    (
        SELECT count(*)::text
        FROM users
        WHERE v2_terms_accepted_at < date '2026-07-01'
    )

UNION ALL

SELECT
    3,
    'User Acquisition',
    'Teams Onboarded',
    'Cumulative count of unique organizations with at least one Trezu.',
    (
        SELECT count(DISTINCT dm.dao_id)::text
        FROM users u
        JOIN dao_members dm
          ON dm.account_id = u.account_id
        JOIN monitored_accounts ma
          ON ma.account_id = dm.dao_id
         AND ma.is_testing IS NOT TRUE
        WHERE u.v2_terms_accepted_at IS NOT NULL
    ),
    NULL,
    NULL

UNION ALL

SELECT
    4,
    'Engagement',
    'Monthly Active Treasuries (MATs)',
    'Treasuries with at least one core action in the current month.',
    (SELECT total::text FROM kr_mats),
    (
        SELECT count(DISTINCT monitored_account_id)::text
        FROM kr__active_treasury_months
        WHERE month_start >= date '2026-01-01'
          AND month_start <  date '2026-04-01'
    ),
    (
        SELECT count(DISTINCT monitored_account_id)::text
        FROM kr__active_treasury_months
        WHERE month_start >= date '2026-04-01'
          AND month_start <  date '2026-07-01'
    )

UNION ALL

SELECT
    5,
    'Engagement',
    'Active Unique Wallets/Members',
    'Unique members belonging to treasuries active in the current month.',
    (SELECT total::text FROM kr_active_wallets),
    NULL,
    NULL

UNION ALL

SELECT
    6,
    'Engagement',
    'Treasury Churn Rate',
    'Share of previous-month active treasuries not active in the following month.',
    (
        SELECT coalesce(to_char(churn_rate * 100, 'FM999990.00') || '%', '0.00%')
        FROM kr_treasury_churn_monthly
        ORDER BY month_start DESC
        LIMIT 1
    ),
    NULL,
    NULL

UNION ALL

SELECT
    7,
    'Monetization',
    'AUM (Assets Under Management)',
    'Total USD value of public assets held in Trezu treasuries.',
    (SELECT '$' || to_char(aum_usd, 'FM999,999,999,999.00') FROM kr_aum_usd),
    NULL,
    NULL

UNION ALL

SELECT
    8,
    'Monetization',
    'Treasury Inflow Volume (USD)',
    'Total positive USD-denominated balance changes.',
    (SELECT '$' || to_char(inflow_usd, 'FM999,999,999,999.00') FROM kr_inflow_usd),
    NULL,
    NULL

UNION ALL

SELECT
    9,
    'Monetization',
    'Annualized Transaction Volume (ATV)',
    'YTD payment outflow plus swap volume, annualized.',
    (SELECT '$' || to_char(atv_usd, 'FM999,999,999,999.00') FROM kr_atv_usd),
    NULL,
    NULL

UNION ALL

SELECT
    10,
    'Monetization',
    'Payment Outflow Volume (USD)',
    'Total paid out, excluding swap deposits and inter-Trezu transfers.',
    (SELECT '$' || to_char(outflow_usd, 'FM999,999,999,999.00') FROM kr_outflow_usd),
    NULL,
    NULL

UNION ALL

SELECT
    11,
    'Monetization',
    'Swap Volume (USD)',
    'Total swap volume using the receive leg of each detected swap.',
    (SELECT '$' || to_char(swap_volume_usd, 'FM999,999,999,999.00') FROM kr_swap_volume_usd),
    NULL,
    NULL

UNION ALL

SELECT
    12,
    'Monetization',
    'Revenue Generated (ARR)',
    'Recurring and usage revenue from all sources.',
    'Not collected — billing not live',
    NULL,
    NULL

UNION ALL

SELECT
    13,
    'Monetization',
    'SaaS Subscriptions',
    'Pro and Enterprise tier recurring revenue.',
    'Not collected — all accounts on free Pro',
    NULL,
    NULL

UNION ALL

SELECT
    14,
    'Monetization',
    'Swap Fees Revenue',
    'Derived 0.35% fee on swap volume. Not actual collected revenue.',
    (
        SELECT '$' || to_char(fees_usd, 'FM999,999,999.00') || ' derived'
        FROM kr_swap_fees_usd
    ),
    NULL,
    NULL;
