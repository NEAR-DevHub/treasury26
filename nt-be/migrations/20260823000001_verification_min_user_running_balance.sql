-- check_assets already gates pass/fail on both the chain-level running
-- minimum (min_balance_after, stored as min_running_balance) and the
-- user-owned running minimum (min_user_balance_after) — but only the
-- former was ever persisted. A user-invariant-only failure reads today as
-- "passed=false, drift=0, min_running_balance positive", with the actual
-- reason invisible outside the source code.
--
-- sponsor_absorbed: how much user-tagged spend the balance-history builder's
-- clamp (assign_running_balances) redirected to sponsor-funded since the
-- last reconciliation anchor. Purely observational — never gates pass/fail —
-- so a spike here is itself the signal that would otherwise have gone
-- unnoticed once the clamp stopped user balances from failing verification.
ALTER TABLE public_balance_verification_results
    ADD COLUMN min_user_running_balance NUMERIC,
    ADD COLUMN sponsor_absorbed NUMERIC;
