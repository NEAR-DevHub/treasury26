-- NocoDB-friendly treasury analytics view.
--
-- Plain Postgres view: NocoDB only needs metadata sync after this migration is
-- applied or if these columns change.
--
-- Public balance-change-backed flow/swap metrics are intentionally skipped in
-- this replacement view to avoid loading the large balance_changes table from
-- NocoDB count/grid requests.

CREATE OR REPLACE VIEW kr_analytics_treasury_monthly AS
WITH treasury_base AS (
    SELECT
        ma.account_id,
        ma.created_at AS monitored_at,
        ma.created_by_trezu_at,
        coalesce(ma.is_confidential_account, false) AS is_confidential_account,
        ma.plan_type,
        d.created_at AS dao_created_at,
        coalesce(ma.created_by_trezu_at, d.created_at, ma.created_at)::date AS trezu_started_on
    FROM monitored_accounts ma
    LEFT JOIN daos d
      ON d.dao_id = ma.account_id
    WHERE ma.is_testing IS NOT TRUE
),
month_bounds AS (
    SELECT
        date_trunc('month', min(trezu_started_on))::date AS min_month,
        date_trunc('month', current_date)::date AS max_month
    FROM treasury_base
),
months AS (
    SELECT generate_series(min_month, max_month, interval '1 month')::date AS month_start
    FROM month_bounds
    WHERE min_month IS NOT NULL
),
treasury_months AS (
    SELECT
        tb.account_id,
        m.month_start,
        (m.month_start + interval '1 month - 1 day')::date AS month_end,
        extract(year FROM m.month_start)::int AS year,
        extract(month FROM m.month_start)::int AS month,
        to_char(m.month_start, 'Mon YYYY') AS month_label,
        tb.trezu_started_on,
        tb.is_confidential_account,
        CASE
            WHEN tb.is_confidential_account THEN 'confidential'
            ELSE 'public'
        END AS treasury_type,
        CASE
            WHEN tb.created_by_trezu_at IS NOT NULL THEN 'trezu_created'
            ELSE 'sputnik_existing'
        END AS origin,
        tb.plan_type,
        greatest(
            (
                extract(year FROM age((m.month_start + interval '1 month - 1 day')::date, tb.trezu_started_on))::int * 12
              + extract(month FROM age((m.month_start + interval '1 month - 1 day')::date, tb.trezu_started_on))::int
            ),
            0
        ) AS age_months
    FROM treasury_base tb
    JOIN months m
      ON m.month_start >= date_trunc('month', tb.trezu_started_on)::date
),
public_latest_aum_snapshot AS (
    SELECT
        pddb.dao_id AS account_id,
        date_trunc('month', pddb.snapshot_date)::date AS month_start,
        max(pddb.snapshot_date) AS snapshot_date
    FROM public_dashboard_daily_balances pddb
    JOIN monitored_accounts ma
      ON ma.account_id = pddb.dao_id
     AND ma.is_testing IS NOT TRUE
     AND ma.is_confidential_account IS NOT TRUE
    WHERE pddb.is_trezu = true
    GROUP BY 1, 2
),
public_monthly_aum AS (
    SELECT
        pddb.dao_id AS account_id,
        plas.month_start,
        plas.snapshot_date::timestamptz AS snapshot_at,
        sum(pddb.total_usd) AS aum_usd
    FROM public_latest_aum_snapshot plas
    JOIN public_dashboard_daily_balances pddb
      ON pddb.dao_id = plas.account_id
     AND pddb.snapshot_date = plas.snapshot_date
    WHERE pddb.is_trezu = true
    GROUP BY 1, 2, 3
),
confidential_flows AS (
    SELECT
        ghe.dao_id AS account_id,
        date_trunc('month', coalesce(ghe.proposal_executed_at, ghe.quote_created_at))::date AS month_start,
        coalesce(sum(greatest(coalesce(ghe.usd_change, ghe.amount_out_usd, 0), 0)) FILTER (
            WHERE ghe.transaction_type = 'deposit'
        ), 0) AS inflow_usd,
        coalesce(sum(abs(coalesce(ghe.usd_change, -ghe.amount_in_usd, -ghe.amount_out_usd, 0))) FILTER (
            WHERE ghe.transaction_type = 'sent'
        ), 0) AS outflow_usd,
        coalesce(sum(coalesce(ghe.amount_out_usd, abs(ghe.usd_change), 0)) FILTER (
            WHERE ghe.transaction_type = 'exchange'
        ), 0) AS swap_volume_usd,
        count(*) FILTER (WHERE ghe.transaction_type = 'sent')::bigint AS payment_count,
        count(*) FILTER (WHERE ghe.transaction_type = 'exchange')::bigint AS swap_count
    FROM gold_confidential_history_events ghe
    JOIN monitored_accounts ma
      ON ma.account_id = ghe.dao_id
     AND ma.is_testing IS NOT TRUE
     AND ma.is_confidential_account IS TRUE
    GROUP BY 1, 2
),
confidential_latest_aum_snapshot AS (
    SELECT
        gcbs.dao_id AS account_id,
        date_trunc('month', gcbs.snapshot_at)::date AS month_start,
        max(gcbs.snapshot_at) AS snapshot_at
    FROM gold_confidential_balance_snapshots gcbs
    JOIN monitored_accounts ma
      ON ma.account_id = gcbs.dao_id
     AND ma.is_testing IS NOT TRUE
     AND ma.is_confidential_account IS TRUE
    GROUP BY 1, 2
),
confidential_monthly_aum AS (
    SELECT
        gcbs.dao_id AS account_id,
        clas.month_start,
        clas.snapshot_at,
        sum(gcbs.value_usd) AS aum_usd
    FROM confidential_latest_aum_snapshot clas
    JOIN gold_confidential_balance_snapshots gcbs
      ON gcbs.dao_id = clas.account_id
     AND gcbs.snapshot_at = clas.snapshot_at
    GROUP BY 1, 2, 3
),
members AS (
    SELECT
        tm.account_id,
        tm.month_start,
        count(dm.account_id)::bigint AS member_count
    FROM treasury_months tm
    LEFT JOIN dao_members dm
      ON dm.dao_id = tm.account_id
     AND dm.created_at < (tm.month_start + interval '1 month')
    GROUP BY 1, 2
),
address_book_size AS (
    SELECT
        tm.account_id,
        tm.month_start,
        count(ab.id)::bigint AS address_book_size
    FROM treasury_months tm
    LEFT JOIN address_book ab
      ON ab.dao_id = tm.account_id
     AND ab.created_at < (tm.month_start + interval '1 month')
    GROUP BY 1, 2
),
usage AS (
    SELECT
        monitored_account_id AS account_id,
        make_date(billing_year, billing_month, 1) AS month_start,
        exports_used,
        batch_payments_used,
        gas_covered_transactions,
        swap_proposals,
        payment_proposals,
        votes_casted
    FROM usage_tracking
),
combined AS (
    SELECT
        tm.account_id,
        tm.month_start,
        tm.is_confidential_account,
        coalesce(pma.aum_usd, cma.aum_usd) AS aum_usd,
        coalesce(pma.snapshot_at, cma.snapshot_at) AS aum_snapshot_at,
        CASE WHEN tm.is_confidential_account THEN coalesce(cf.inflow_usd, 0) ELSE 0::numeric END AS inflow_usd,
        CASE WHEN tm.is_confidential_account THEN coalesce(cf.outflow_usd, 0) ELSE 0::numeric END AS outflow_usd,
        CASE WHEN tm.is_confidential_account THEN coalesce(cf.swap_volume_usd, 0) ELSE 0::numeric END AS swap_volume_usd,
        CASE WHEN tm.is_confidential_account THEN coalesce(cf.payment_count, 0) ELSE 0::bigint END AS fallback_payment_count,
        CASE WHEN tm.is_confidential_account THEN coalesce(cf.swap_count, 0) ELSE 0::bigint END AS fallback_swap_count
    FROM treasury_months tm
    LEFT JOIN public_monthly_aum pma
      ON pma.account_id = tm.account_id
     AND pma.month_start = tm.month_start
    LEFT JOIN confidential_monthly_aum cma
      ON cma.account_id = tm.account_id
     AND cma.month_start = tm.month_start
    LEFT JOIN confidential_flows cf
      ON cf.account_id = tm.account_id
     AND cf.month_start = tm.month_start
)
SELECT
    tm.account_id,
    tm.month_start,
    tm.month_end,
    tm.year,
    tm.month,
    tm.month_label,
    tm.trezu_started_on,
    tm.age_months,
    tm.treasury_type,
    tm.origin,
    tm.plan_type::text AS plan_type,

    coalesce(m.member_count, 0) AS members,

    c.aum_usd,
    c.aum_snapshot_at,
    c.inflow_usd,
    c.outflow_usd,
    c.inflow_usd - c.outflow_usd AS netflow_usd,
    c.swap_volume_usd,
    c.inflow_usd + c.outflow_usd + c.swap_volume_usd AS volume_usd,
    CASE
        WHEN c.aum_usd > 0 THEN (c.inflow_usd + c.outflow_usd + c.swap_volume_usd) / c.aum_usd
        ELSE NULL
    END AS utilization_ratio,

    coalesce(u.payment_proposals, c.fallback_payment_count, 0)::bigint AS payments,
    coalesce(u.votes_casted, 0)::bigint AS votes,
    coalesce(u.swap_proposals, c.fallback_swap_count, 0)::bigint AS swaps,
    coalesce(u.batch_payments_used, 0)::bigint AS batch_payments,
    coalesce(absz.address_book_size, 0) AS address_book_size,
    coalesce(u.exports_used, 0)::bigint AS exports,
    coalesce(u.gas_covered_transactions, 0)::bigint AS gas_covered_transactions,

    (0.0035::numeric * c.swap_volume_usd) AS derived_swap_fee_revenue_usd,

    NULLIF(greatest(
        coalesce(last_confidential.last_activity_at, '-infinity'::timestamptz),
        coalesce(last_usage.last_usage_at, '-infinity'::timestamptz)
    ), '-infinity'::timestamptz) AS last_activity_at
FROM treasury_months tm
JOIN combined c
  ON c.account_id = tm.account_id
 AND c.month_start = tm.month_start
LEFT JOIN members m
  ON m.account_id = tm.account_id
 AND m.month_start = tm.month_start
LEFT JOIN address_book_size absz
  ON absz.account_id = tm.account_id
 AND absz.month_start = tm.month_start
LEFT JOIN usage u
  ON u.account_id = tm.account_id
 AND u.month_start = tm.month_start
LEFT JOIN LATERAL (
    SELECT max(coalesce(ghe.proposal_executed_at, ghe.quote_created_at)) AS last_activity_at
    FROM gold_confidential_history_events ghe
    WHERE ghe.dao_id = tm.account_id
      AND coalesce(ghe.proposal_executed_at, ghe.quote_created_at) < (tm.month_start + interval '1 month')
) last_confidential ON true
LEFT JOIN LATERAL (
    SELECT max(ut.updated_at) AS last_usage_at
    FROM usage_tracking ut
    WHERE ut.monitored_account_id = tm.account_id
      AND make_date(ut.billing_year, ut.billing_month, 1) <= tm.month_start
) last_usage ON true;
