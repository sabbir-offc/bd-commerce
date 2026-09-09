# Changelog

## 0.2.0 — unreleased

### Added

- `PathaoClient`: `createOrder`, `createOrders`, `getStatusByConsignmentId`, `listCities`,
  `listZones`, `listAreas`, `resolveLocation`, `listStores`, `createStore`, `calculatePrice`.
  Supports both the `issue-token` password grant and the client-credentials `external/login`.
- Pathao's city, zone and area lists are cached for the life of the client.
- `scripts/smoke-pathao.ts`, which runs the whole Pathao sandbox flow end to end with no human in
  the loop.
- `CourierOrder.deliveryFee`, populated where the courier quotes at create time.
- Token management moved to `src/core/token.ts` and is now shared by bKash and Pathao.

### Changed

- **`Courier` is generic over its create input** (`Courier<TCreateInput>`). Pathao needs numeric
  city and zone ids that Steadfast's free-text address does not, and widening the shared input
  would have made required fields look optional.
- **`getStatusByInvoice`, `getStatusByTrackingCode` and `getBalance` are optional on `Courier`.**
  Pathao offers none of them. Probe before calling: `await courier.getBalance?.()`.
- The root barrel now lists its exports explicitly. Steadfast and Pathao both have a
  `toDeliveryStatus`, so they are re-exported as `toSteadfastDeliveryStatus` and
  `toPathaoDeliveryStatus`; the unprefixed names remain on each subpath.
- `BkashToken.idToken` is now `accessToken`, shared with Pathao.

### Verified against the live sandbox

Pathao's auth, store list, city/zone/area lists and price plan match the types in this package
exactly. Order creation could not be confirmed: Pathao's shared public sandbox merchant is in
arrears and answers 402.

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
