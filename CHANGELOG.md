# Changelog

## 0.4.0

The first release published to npm. Versions 0.1.0 through 0.3.0 below were developed and tagged in
the repository but never published, so this is what a consumer sees first.

**Not yet exercised against live merchant credentials.** Pathao's read surface and RedX's transport
are confirmed against the real APIs; the order-creation and payment paths are not. See the
verification note in the README before putting this in front of real money.

### Added

- `NagadClient`: `createPayment` (both legs of the initialize/complete handshake), `verifyPayment`,
  and the static `parseCallback`.
- `createNodeCrypto`, `dhakaTimestamp` and `randomChallenge` are exported for anyone who needs the
  pieces directly, and `NagadCryptoProvider` lets you swap the RSA implementation.
- Key loading accepts PEM or the bare base64 the merchant portal hands you.
- `toPaymentOutcome` / `isPaid`, normalizing Nagad's statuses. Only `Success` is ever `success`.
- `scripts/smoke-nagad.ts`.

### Notes

- **`bd-commerce/nagad` is Node-only and is deliberately not re-exported from the package root.**
  Nagad encrypts with RSAES-PKCS1-v1_5, which WebCrypto does not implement, so the client imports
  `node:crypto`. Keeping it on its own subpath is what preserves edge compatibility for the other
  four providers; CI asserts the root bundle contains no crypto import.
- The signature algorithm is ambiguous: Nagad's guide says SHA1withRSA, common implementations use
  SHA256. Default is SHA256, switchable via `signatureAlgorithm`, and the verification error names
  the alternative.

## 0.3.0 — unreleased

### Added

- `RedxClient`: `createOrder`, `createOrders`, `getStatusByConsignmentId`,
  `getStatusByTrackingCode`, `track`, `listAreas`, `resolveArea`, `listPickupStores`,
  `getPickupStore`. Authenticates with RedX's `API-ACCESS-TOKEN` header; there is no OAuth
  exchange and nothing to refresh.
- `parcelWeightGrams`, named for its unit and rejecting non-integers, because RedX measures in
  grams where Pathao measures in kilograms.
- `items` is serialized into RedX's `parcel_details_json` for you.
- `scripts/smoke-redx.ts`, read-only by default; creating against production takes
  `--live --create --confirm-live`.

### Changed

- The root barrel prefixes both providers' `needsAttention` (`pathaoNeedsAttention`,
  `redxNeedsAttention`), matching what was already done for `toDeliveryStatus`. The unprefixed
  names remain on each subpath.

### Verified against the live API

RedX's sandbox host, `v1.0.0-beta` path prefix and `API-ACCESS-TOKEN` header are confirmed: an
invalid token returns 401, not 404. Its success paths need a merchant token and are unverified.

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
