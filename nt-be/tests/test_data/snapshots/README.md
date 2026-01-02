# Test Snapshots

This directory contains snapshot reference files for balance history API tests.

## Files

- `csv_export_snapshot.csv` - Reference CSV export output (204 rows: 1 header + 203 data rows)
- `chart_hourly_snapshot.json` - Hourly interval chart data (June-December 2025)
- `chart_daily_snapshot.json` - Daily interval chart data (214 days)
- `chart_weekly_snapshot.json` - Weekly interval chart data (~31 weeks)
- `chart_monthly_snapshot.json` - Monthly interval chart data (7 months)

## How It Works

The tests compare API output against these snapshot files to detect regressions:
1. Generate output from the balance history APIs using `webassemblymusic-treasury` test data
2. Compare output against snapshot files (hard assertion - tests fail if different)
3. Ensure consistent behavior across code changes

## Generating New Snapshots

Snapshots are only generated when the `GENERATE_NEW_TEST_SNAPSHOTS` environment variable is set.

To regenerate all snapshots:

```bash
GENERATE_NEW_TEST_SNAPSHOTS=1 cargo test --test balance_history_apis_test
```

After regenerating:
1. Review the diffs to ensure changes are intentional
2. Commit the updated snapshot files

## Test Coverage

These snapshots verify:
- Exact row counts for CSV exports (204 rows)
- Token counts per interval (12 tokens)
- Data point counts for each token at each interval
- Consistent output structure and data across runs
