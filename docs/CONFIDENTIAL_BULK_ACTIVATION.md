# Confidential bulk-payment activation (existing treasuries)

Newly created confidential treasuries get bulk payments provisioned during
creation (the backend signer is the sole threshold-1 member at that point,
so it can approve the required proposal itself). Treasuries created before
the feature — or whose creation-time setup failed — need a retrofit that
goes through their real multisig: **one round of approvals to register the
confidential bulk access key**.

## Flow

```
user (member)                     backend                        multisig
-------------                     -------                        --------
opens Bulk payments page
  → GET  …/bulk-payment/activation            (status: inactive)
clicks "Start activation"
  → POST …/bulk-payment/activation/prepare
                                  ensures <prefix>.bulkpayment.near
                                  exists + MPC-bootstrapped
                                  (factory call, subsidized, idempotent)
                                  builds v1.signer `sign` auth proposal,
                                  stores payload as confidential_intents
                                  row (intent_type = 'bulk_auth')
  ← { proposal, payloadHash }
creates the proposal (wallet)                                    members approve
                                  final approving vote executes
                                  v1.signer.sign; the vote relay
                                  (try_auto_submit_intent) extracts the
                                  MPC signature, authenticates the sub
                                  with 1Click, stores the JWT in
                                  monitored_accounts.bulk_payment_*
page polls GET …/activation       (status: active) → form unlocks
```

## Pieces

Backend (`nt-be`):
- `handlers/intents/confidential/bulk_activation.rs` — status + prepare
  routes (`GET/POST /api/confidential-intents/bulk-payment/activation[…/prepare]`)
- `handlers/treasury/confidential_setup.rs::ensure_bulk_subaccount` —
  extracted from the creation path; idempotent factory call + bootstrap poll
- `handlers/relay/confidential.rs` — new `bulk_auth` intent type: MPC key
  fetched with empty signing path, JWT stored in the `bulk_payment_*`
  columns (the `auth` type keeps writing the `confidential_*` columns)

Frontend (`nt-fe`):
- `features/confidential/hooks/use-bulk-activation.ts` — status query
  (polls every 10s while awaiting approvals) + prepare mutation
- `features/confidential/components/bulk-activation-card.tsx` — the flow UI
  (start/retry → awaiting approvals → auto-unlock)
- `app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx` — gates the
  bulk form on activation for confidential treasuries
- i18n: `bulkActivation` block in all 10 locales

## Notes / limitations

- `prepare` is idempotent: re-running supersedes the previous pending
  attempt (`status = 'superseded'`); an approval of a superseded proposal
  is ignored (relay finds no pending row for its hash).
- The auth payload embeds a deadline (`CONFIDENTIAL_AUTH_EXPIRES_DAYS`).
  If the multisig takes longer than that to approve, 1Click rejects the
  authentication, the row is marked `failed`, and the UI offers a retry.
- Completion relies on the final approving vote going through the app's
  vote relay (which is how votes are cast in this app). A vote cast from
  an external tool skips the relay; the UI keeps showing "awaiting
  approval" — restarting the flow (prepare + new proposal) recovers.
- No new tables: pending activations reuse `confidential_intents` with
  `intent_type = 'bulk_auth'` (new value alongside `auth`, `shield`,
  `bulk_recipient`).
