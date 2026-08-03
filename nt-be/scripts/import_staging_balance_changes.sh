#!/usr/bin/env bash
# Import balance_changes history for selected DAOs from the staging database
# into a local database, so the sparse public-balance-snapshot seed can be
# tested against real data.
#
# Staging is treated as strictly read-only: this script only ever SELECTs
# from it. All writes go to the target database.
#
# Usage:
#   STAGING_DATABASE_URL=postgres://... ./scripts/import_staging_balance_changes.sh \
#       [--reset-snapshots] <dao> [dao...]
#
# Target database: TARGET_DATABASE_URL if set, otherwise DATABASE_URL from
# nt-be/.env.
#
# Per DAO this script:
#   1. deletes the DAO's existing balance_changes rows in the target,
#   2. streams the DAO's rows from staging and inserts them,
#   3. upserts an enabled, non-confidential monitored_accounts row,
#   4. with --reset-snapshots: clears the DAO's public_balance_snapshot rows
#      and cursor so the next sweeper tick bootstraps and re-seeds it.

set -euo pipefail
cd "$(dirname "$0")/.."

RESET_SNAPSHOTS=false
DAOS=()
for arg in "$@"; do
    case "$arg" in
        --reset-snapshots) RESET_SNAPSHOTS=true ;;
        --*) echo "unknown flag: $arg" >&2; exit 1 ;;
        *) DAOS+=("$arg") ;;
    esac
done

if [[ ${#DAOS[@]} -eq 0 ]]; then
    echo "usage: STAGING_DATABASE_URL=... $0 [--reset-snapshots] <dao> [dao...]" >&2
    exit 1
fi

STAGING_URL="${STAGING_DATABASE_URL:-}"
if [[ -z "$STAGING_URL" ]]; then
    echo "STAGING_DATABASE_URL must be set (staging is read from, never written)" >&2
    exit 1
fi

TARGET_URL="${TARGET_DATABASE_URL:-}"
if [[ -z "$TARGET_URL" && -f .env ]]; then
    TARGET_URL="$(grep '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
fi
if [[ -z "$TARGET_URL" ]]; then
    echo "no target database: set TARGET_DATABASE_URL or DATABASE_URL in nt-be/.env" >&2
    exit 1
fi
if [[ "$TARGET_URL" == "$STAGING_URL" ]]; then
    echo "refusing to run: target database equals staging database" >&2
    exit 1
fi

for dao in "${DAOS[@]}"; do
    if [[ ! "$dao" =~ ^[a-z0-9._-]+$ ]]; then
        echo "invalid account id: $dao" >&2
        exit 1
    fi
done

# Copy only columns both sides know (minus the serial id), so the script
# survives schema drift between staging and the local branch.
columns_of() {
    psql "$1" -tA -c "
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'balance_changes'
          AND column_name <> 'id'
        ORDER BY column_name"
}
COLS="$(comm -12 <(columns_of "$STAGING_URL") <(columns_of "$TARGET_URL") | paste -sd, -)"
if [[ -z "$COLS" ]]; then
    echo "could not derive a shared balance_changes column list" >&2
    exit 1
fi
echo "columns: $COLS"

TMP_CSV="$(mktemp -t balance_changes_import)"
trap 'rm -f "$TMP_CSV"' EXIT

for dao in "${DAOS[@]}"; do
    echo "==> $dao"
    staging_count="$(psql "$STAGING_URL" -tA -c \
        "SELECT count(*) FROM balance_changes WHERE account_id = '$dao'")"
    echo "    staging rows: $staging_count"

    psql "$STAGING_URL" -q -v ON_ERROR_STOP=1 -c \
        "\\copy (SELECT $COLS FROM balance_changes WHERE account_id = '$dao' ORDER BY token_id NULLS FIRST, block_height) TO '$TMP_CSV' (FORMAT csv)"

    psql "$TARGET_URL" -q -v ON_ERROR_STOP=1 <<SQL
BEGIN;
CREATE TEMP TABLE import_rows AS
    SELECT $COLS FROM balance_changes WITH NO DATA;
\\copy import_rows ($COLS) FROM '$TMP_CSV' (FORMAT csv)
-- detected_swaps is derived data keyed to balance_changes ids; the import
-- replaces those ids, so the DAO's swap rows must go first (they are
-- re-derived by the swap detector against the imported ledger).
DELETE FROM detected_swaps
    WHERE account_id = '$dao'
       OR deposit_balance_change_id IN (
           SELECT id FROM balance_changes WHERE account_id = '$dao')
       OR fulfillment_balance_change_id IN (
           SELECT id FROM balance_changes WHERE account_id = '$dao');
DELETE FROM balance_changes WHERE account_id = '$dao';
INSERT INTO balance_changes ($COLS)
    SELECT $COLS FROM import_rows
    ORDER BY token_id NULLS FIRST, block_height
    ON CONFLICT DO NOTHING;
INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
    VALUES ('$dao', true, false)
    ON CONFLICT (account_id) DO UPDATE
    SET enabled = true, is_confidential_account = false;
COMMIT;
SQL

    if [[ "$RESET_SNAPSHOTS" == true ]]; then
        psql "$TARGET_URL" -q -v ON_ERROR_STOP=1 -c \
            "DELETE FROM public_balance_snapshot WHERE dao_id = '$dao';
             DELETE FROM public_balance_snapshot_cursors WHERE account_id = '$dao';"
        echo "    snapshot state reset (next sweeper tick re-seeds)"
    fi

    imported="$(psql "$TARGET_URL" -tA -c \
        "SELECT count(*) FROM balance_changes WHERE account_id = '$dao'")"
    echo "    imported rows: $imported"
done

echo "done"
