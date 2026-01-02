APIs for querying historical balances
====================================

We want APIs to support the balance history charts in the frontend, and APIs for downloading balance change history as a csv file.

# Chart APIs

This API should return balance snapshots within the requested timeframe and intervals. If the request asks for daily balances since 2025-01-01 and 10 days back in time, then 10 balance snapshot records per token should be generated and returned in the response. If the request is for hourly intervals, then snapshot records need to be calculated/generated on an hourly interval.

The dataset is not organized to be returned directly as is for these kind of requests. The API needs to find all the balance change records in the requested timeframe, and generate snapshot balance records to be returned for each data point with the intervals requested.

## Snapshot Calculation Algorithm

**Chosen Approach:** For each interval point, query backwards to find the most recent balance_after before that timestamp.

**Implementation:** Load the entire dataset into memory for fast calculation.

**Edge Cases:**
- **Before first record:** Return zero if the requested timeframe is before any recorded balance changes
- **Data gaps:** Show last known balance (carry forward)
- **No changes:** Return all data points at the requested intervals (needed for chart rendering)

## Request Parameters

**Required:**
- `account_id`: The NEAR account to query
- `start_time`: Beginning of timeframe in format YYYY-MM-DDTHH:mm:ss (ISO 8601 without timezone)
- `end_time`: End of timeframe in format YYYY-MM-DDTHH:mm:ss (ISO 8601 without timezone)
- `interval`: One of: "hourly", "daily", "weekly", "monthly"

**Optional:**
- `token_ids`: Array of specific tokens to include. If omitted, returns data for all tokens.

## Response Format

**Chosen:** Grouped by token

```json
{
  "near": [
    {"timestamp": "2025-01-01T00:00:00Z", "balance": "1234.5"},
    {"timestamp": "2025-01-02T00:00:00Z", "balance": "1250.0"}
  ],
  "usdc.near": [
    {"timestamp": "2025-01-01T00:00:00Z", "balance": "500"},
    {"timestamp": "2025-01-02T00:00:00Z", "balance": "500"}
  ]
}
```

# CSV API

This is simply returning the balance change history as is. SNAPSHOT records are not needed, we only want balance changes. The API can have an option to request a specified timeframe.

## Filtering Rules

**Exclude:**
- Records with `counterparty = "SNAPSHOT"`
- Records with `counterparty = "NOT_REGISTERED"`

**Include:**
- All actual balance changes with identifiable counterparties

## Request Parameters

**Required:**
- `account_id`: The NEAR account to export
- `start_time`: Start of timeframe in format YYYY-MM-DD (date only, inclusive)
- `end_time`: End of timeframe in format YYYY-MM-DD (date only, exclusive)

**Optional:**
- `token_ids`: Array of specific tokens to include. If omitted, returns data for all tokens.

## CSV Column Structure

**Columns:**
- `block_height`
- `block_time` (human-readable timestamp)
- `token_id`
- `token_symbol` (for readability)
- `counterparty`
- `amount` (positive for incoming, negative for outgoing)
- `balance_before`
- `balance_after`
- `transaction_hashes` (comma-separated list)
- `receipt_id`

**Notes:**
- Decimals not included since balances are already decimal-adjusted
- `actions` and `raw_data` NOT included (too large) 

## Performance Considerations

**Confirmed approach:**
- No pagination - return all data in the selected timeframe
- No streaming - standard response
- No rate limiting (for now)
