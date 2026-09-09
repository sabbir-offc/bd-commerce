# Changelog

## 0.1.0 — unreleased

First cut. Steadfast courier and bKash tokenized checkout.

### Added

- `SteadfastClient`: `createOrder`, `createOrders` (bulk, up to 500, per-row outcomes),
  `getStatusByConsignmentId`, `getStatusByInvoice`, `getStatusByTrackingCode`, `getBalance`.
- `BkashClient`: `createPayment`, `executePayment`, `queryPayment`, `refund`, `searchTransaction`,
  and the static `parseCallback`.
- Token caching for bKash with concurrent-call deduplication, refresh-then-grant fallback, and a
  pluggable `BkashTokenStore` for serverless deployments.
- Shared HTTP layer: per-attempt timeouts, jittered backoff, `Retry-After` handling, and writes
  excluded from replay by default.
- Error hierarchy under `BdCommerceError`, with `ProviderError` for business failures returned
  inside an HTTP 200.
- `normalizeBdPhone`, `isBdPhone`, `toInternational`.
- Normalized delivery statuses, with Steadfast's `*_approval_pending` states mapped to `in_review`
  and flagged via `pendingApproval` rather than reported as final.

### Known limits

- Not yet exercised against live merchant credentials. See the verification note in the README.
- Pathao, RedX, and Nagad are not implemented. See [ROADMAP.md](ROADMAP.md).
