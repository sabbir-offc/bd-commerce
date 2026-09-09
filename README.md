# bd-commerce

[![npm](https://img.shields.io/npm/v/bd-commerce.svg)](https://www.npmjs.com/package/bd-commerce)
[![CI](https://github.com/sabbir-offc/bd-commerce/actions/workflows/ci.yml/badge.svg)](https://github.com/sabbir-offc/bd-commerce/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/bd-commerce.svg)](LICENSE)

Typed TypeScript clients for the infrastructure Bangladeshi e-commerce actually runs on: **Steadfast**,
**Pathao** and **RedX** for delivery, **bKash** and **Nagad** for payment.

Every shop writes these five integrations, and most rewrites repeat the same handful of expensive
mistakes — unsettled delivery statuses treated as final, payments marked paid on a redirect that was
never executed, a retried request that ships the parcel twice. This is one careful implementation of
all five, so you can stop writing the sixth.

> **Status:** published and usable, but the order-creation and payment paths have not yet run against
> live merchant credentials. Read [Verification status](#verification-status) before putting this in
> front of real money.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [What each provider supports](#what-each-provider-supports)
- [What this protects you from](#what-this-protects-you-from)
- [Couriers](#couriers) — [Steadfast](#steadfast), [Pathao](#pathao), [RedX](#redx)
- [Payments](#payments) — [bKash](#bkash), [Nagad](#nagad)
- [Errors](#errors), [Retries](#retries-and-idempotency), [Phone numbers](#phone-numbers)
- [Verification status](#verification-status)

## Install

```bash
npm install bd-commerce
```

Node 18.17 or newer. Zero runtime dependencies — native `fetch` only, so it also runs on Bun, Deno
and edge runtimes. The single exception is `bd-commerce/nagad`, which needs `node:crypto`; it is
deliberately kept off the package root so importing `bd-commerce` stays edge-safe for everyone else.

Ships ESM and CJS with full type declarations. Import the root for everything, or a subpath to keep
bundles small:

```ts
import { SteadfastClient } from 'bd-commerce/steadfast'
import { PathaoClient } from 'bd-commerce/pathao'
import { RedxClient } from 'bd-commerce/redx'
import { BkashClient } from 'bd-commerce/bkash'
import { NagadClient } from 'bd-commerce/nagad'
```

## Quick start

Ship a cash-on-delivery order:

```ts
import { SteadfastClient } from 'bd-commerce/steadfast'

const steadfast = new SteadfastClient({
  apiKey: process.env.STEADFAST_API_KEY!,
  secretKey: process.env.STEADFAST_SECRET_KEY!,
})

const order = await steadfast.createOrder({
  invoice: 'ORD-1042',
  recipientName: 'Rahim Uddin',
  recipientPhone: '+8801712345678', // any BD format; normalized for you
  recipientAddress: 'House 4, Road 11, Banani, Dhaka',
  codAmount: 1250,
})

order.consignmentId // '1424107'
order.trackingCode // '15BAEB8A'
```

Take a payment:

```ts
import { BkashClient } from 'bd-commerce/bkash'

const bkash = new BkashClient({ ...credentials, sandbox: true })

// At checkout.
const payment = await bkash.createPayment({
  amount: 1250,
  invoiceNumber: 'ORD-1042',
  callbackURL: 'https://shop.example.com/api/bkash/callback',
})
redirect(payment.bkashUrl)

// In the callback route. Nothing is charged until this succeeds.
const executed = await bkash.executePayment(paymentId)
```

## What each provider supports

Couriers share a `Courier` interface, generic over its create input because they genuinely differ:
Steadfast takes a free-text address, Pathao requires ids from its own hierarchy. Methods marked "no"
are absent from the interface rather than throwing — probe with `await courier.getBalance?.()`.

|                             | Steadfast       | Pathao                     | RedX                  |
| --------------------------- | --------------- | -------------------------- | --------------------- |
| `createOrder`               | yes             | yes                        | yes                   |
| `createOrders` (bulk)       | yes, up to 500  | yes                        | yes, sequential       |
| `getStatusByConsignmentId`  | yes             | yes                        | yes                   |
| `getStatusByInvoice`        | yes             | no                         | no                    |
| `getStatusByTrackingCode`   | yes             | no, id is the reference    | yes                   |
| `getBalance`                | yes             | no                         | no                    |
| Full tracking timeline      | no              | no                         | `track()`             |
| Price quote before shipping | no              | `calculatePrice()`         | no                    |
| Address                     | free text       | `resolveLocation()` or ids | `resolveArea()` or id |
| Weight                      | not sent        | **kilograms**              | **grams**             |
| Auth                        | static key pair | OAuth, refreshable         | static token          |

Payments:

|                       | bKash                         | Nagad                                  |
| --------------------- | ----------------------------- | -------------------------------------- |
| Create a payment      | `createPayment()`             | `createPayment()`, both handshake legs |
| Confirm it            | `executePayment()`            | `verifyPayment()`                      |
| Reconcile later       | `queryPayment()`              | `verifyPayment()`                      |
| Refund                | `refund()`                    | no                                     |
| Parse the callback    | `BkashClient.parseCallback()` | `NagadClient.parseCallback()`          |
| Runs on edge runtimes | yes                           | **no** — needs `node:crypto`           |

## What this protects you from

These are the mistakes the package exists to prevent. Each one is real, and each one is expensive.

| The trap                                                         | What this does                                                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Steadfast reports a parcel delivered before the money is settled | Maps the four `*_approval_pending` statuses to `in_review`, never `delivered`. [Detail](#delivery-status-and-the-trap-in-it)  |
| Steadfast locks your API key after repeated bad credentials      | Puts the remaining `attempts_left` in the error and never retries an auth failure. [Detail](#credential-attempts-are-limited) |
| A bKash or Nagad redirect looks like a successful payment        | Only `executePayment` / `verifyPayment` is treated as proof, and both are documented that way                                 |
| Pathao and RedX hide failed pickups inside "in transit"          | Failed attempts normalize to `on_hold`, where a merchant will actually see them                                               |
| Retrying a create ships a second parcel                          | No write is ever replayed, at any provider                                                                                    |
| RedX weighs in grams, Pathao in kilograms                        | The field is `parcelWeightGrams` and rejects a non-integer outright                                                           |
| bKash rate-limits token grants, breaking serverless              | Pluggable token store, with concurrent grants deduplicated                                                                    |
| Pathao's city list 404s at the obvious path                      | Uses `countries/1/city-list`, taken from Pathao's own plugin                                                                  |

## Couriers

### Steadfast

```ts
const steadfast = new SteadfastClient({ apiKey, secretKey })
```

Bulk creation takes up to 500 orders and reports each row separately, because Steadfast fails rows
individually rather than rejecting the batch:

```ts
const results = await steadfast.createOrders(orders)

for (const result of results) {
  if (result.ok) await markShipped(result.invoice, result.order.trackingCode)
  else await flagForReview(result.invoice, result.message)
}
```

#### Delivery status, and the trap in it

Steadfast has four `*_approval_pending` statuses. They mean a rider reported an outcome the courier
has **not settled** — it can still flip, and the COD money has not moved. Code that checks
`delivery_status === 'delivered'` against the raw API will mark orders paid that later come back.

All four map to `in_review`, flagged:

```ts
const status = await steadfast.getStatusByInvoice('ORD-1042')

status.status // 'in_review'
status.pendingApproval // true
status.providerStatus // 'delivered_approval_pending' — the raw value, untouched

if (status.status === 'delivered') {
  await settleOrder('ORD-1042') // only reached on a settled delivery
}
```

To show the unsettled outcome optimistically in a dashboard, `reportedStatus()` gives you what the
rider claimed without pretending it is final.

#### Credential attempts are limited

Steadfast counts down `attempts_left` on every rejected credential and locks the API key at zero. A
typo in a production environment variable can lock a live merchant out of their own courier, so the
remaining count goes straight into the error and auth failures are never retried:

```
steadfast: Unauthorized Access (invalid API credentials) — 9 credential attempts left before the key is locked
```

**Do not test Steadfast with deliberately wrong keys.**

Also available: `getStatusByConsignmentId`, `getStatusByTrackingCode`, `getBalance`.

### Pathao

Pathao needs two things Steadfast does not: a store, and an address as numeric ids from its own
city/zone/area hierarchy.

```ts
const pathao = new PathaoClient({
  clientId,
  clientSecret,
  username,
  password,
  defaultStoreId: Number(process.env.PATHAO_STORE_ID),
})

const where = await pathao.resolveLocation({ city: 'Dhaka', zone: 'Banani' })

const order = await pathao.createOrder({
  invoice: 'ORD-1042',
  recipientName: 'Rahim Uddin',
  recipientPhone: '01712345678',
  recipientAddress: 'House 4, Road 11, Banani, Dhaka',
  recipientCity: where.cityId,
  recipientZone: where.zoneId,
  codAmount: 1250,
  itemWeight: 0.5, // kilograms — this sets the fee, so there is no default
})

order.consignmentId // 'DH210827A9QWE'
order.deliveryFee // 60
```

`resolveLocation` is a deliberate separate step rather than something `createOrder` does for you.
Silently picking the wrong zone sends a parcel to the wrong side of Dhaka, and that failure stays
invisible until it is expensive — so an unknown or ambiguous name throws with the closest candidates
listed. Build your own picker with `listCities()`, `listZones(cityId)` and `listAreas(zoneId)` if you
prefer; all three are cached for the life of the client.

Quote before you commit:

```ts
const price = await pathao.calculatePrice({
  recipientCity: where.cityId,
  recipientZone: where.zoneId,
  itemWeight: 0.5,
})
price.final_price // 60
```

#### Failed attempts are not "in transit"

Pathao reports `Pickup_Failed` and `Delivery_Failed`. Neither means the parcel is moving — nothing
happens until someone acts — so both normalize to `on_hold` rather than hiding inside `in_transit`
where a merchant filtering for active parcels would never see them again:

```ts
const status = await pathao.getStatusByConsignmentId(order.consignmentId)
if (status.status === 'on_hold') await escalate(order.invoice, status.providerStatus)
```

Also available: `createOrders`, `listStores`, `createStore`.

### RedX

RedX issues a long-lived merchant token rather than running an OAuth exchange, so there is nothing to
refresh. Its addresses are a flat area list, not a hierarchy.

```ts
const redx = new RedxClient({
  accessToken: process.env.REDX_ACCESS_TOKEN!,
  defaultPickupStoreId: Number(process.env.REDX_STORE_ID),
})

const area = await redx.resolveArea('Banani')

const order = await redx.createOrder({
  invoice: 'ORD-1042',
  recipientName: 'Rahim Uddin',
  recipientPhone: '01712345678',
  recipientAddress: 'House 4, Road 11, Banani, Dhaka',
  deliveryAreaId: area.id,
  deliveryArea: area.name, // RedX wants both the id and the name
  codAmount: 1250,
  parcelWeightGrams: 500,
})

order.trackingCode // '21J9L5PP3AB4'
```

#### Weight is in grams here

RedX measures parcels in **grams**; Pathao measures in **kilograms**. Porting an integration between
the two is the obvious way to ship a half-gram parcel and get charged for it. So the field is named
for its unit, and a non-integer is rejected outright:

```ts
await redx.createOrder({ ...order, parcelWeightGrams: 0.5 })
// ValidationError: `parcelWeightGrams` must be a whole number of grams —
// RedX measures in grams, not kilograms — got 0.5
```

`createOrders` posts sequentially because RedX has no batch endpoint, and validates every row before
sending any of them — a bad row at index 40 should not leave 39 real parcels behind it.

Also available: `track` (full event timeline), `listAreas`, `listPickupStores`, `getPickupStore`.

## Payments

Both gateways share one rule: **the redirect is not the payment.** The shopper coming back to your
callback tells you which branch to take and nothing more. A second call proves the money moved.

### bKash

```ts
const bkash = new BkashClient({
  appKey,
  appSecret,
  username,
  password,
  sandbox: process.env.NODE_ENV !== 'production',
})
```

```ts
// 1. At checkout: create, then redirect.
const payment = await bkash.createPayment({
  amount: 1250,
  invoiceNumber: 'ORD-1042',
  callbackURL: 'https://shop.example.com/api/bkash/callback',
})
redirect(payment.bkashUrl)
```

```ts
// 2. In the callback route: execute. No money moves until this succeeds.
const { paymentId, status } = BkashClient.parseCallback(request.url)
if (status !== 'success') return redirect('/checkout/cancelled')

const executed = await bkash.executePayment(paymentId)
await markPaid('ORD-1042', executed.trxId)
```

If a callback never arrives — closed tab, dropped network — reconcile with `queryPayment(paymentId)`
rather than guessing.

#### Token caching in serverless

bKash rate-limits token grants. The default store lives in process memory, which is right for a
long-running server and wrong for serverless, where every cold start grants again:

```ts
const bkash = new BkashClient({
  ...credentials,
  tokenStore: {
    async get() {
      const raw = await redis.get('bkash:token')
      return raw ? JSON.parse(raw) : null
    },
    async set(token) {
      await redis.set('bkash:token', JSON.stringify(token), { EX: 3500 })
    },
    async clear() {
      await redis.del('bkash:token')
    },
  },
})
```

Concurrent calls in one process share a single grant, and a token rejected mid-life is re-granted and
retried once automatically.

Also available: `refund`, `searchTransaction`.

### Nagad

**Node only.** Nagad encrypts with RSAES-PKCS1-v1_5, which WebCrypto does not implement — it offers
only RSA-OAEP — so this client uses `node:crypto`. That is why Nagad is the one provider not
re-exported from the package root. Supply your own `crypto` provider to run it elsewhere.

```ts
const nagad = new NagadClient({
  merchantId,
  merchantNumber,
  merchantPrivateKey: process.env.NAGAD_PRIVATE_KEY!, // PEM or bare base64
  nagadPublicKey: process.env.NAGAD_PUBLIC_KEY!,
  callbackUrl: 'https://shop.example.com/api/nagad/callback',
})
```

Nagad's checkout is a two-leg handshake — initialize, then complete, echoing back a challenge it
returns in between. `createPayment` does both, because a half-finished handshake leaves a payment
reference that can never be used:

```ts
// 1. At checkout.
const payment = await nagad.createPayment({ orderId: 'ORD-1042', amount: 1250 })
redirect(payment.redirectUrl)
```

```ts
// 2. In the callback route.
const { paymentReferenceId } = NagadClient.parseCallback(request.url)

const verified = await nagad.verifyPayment(paymentReferenceId)
if (verified.outcome === 'success') {
  await markPaid(verified.orderId, verified.issuerPaymentRefNo)
}
```

Only `outcome === 'success'` means money moved. `Aborted` and `Cancelled` both normalize to
`cancelled`, and anything unrecognized becomes `unknown` — never `success`.

#### Things that bite on a first Nagad integration

All three are handled for you, and all three are why a first attempt usually fails:

- **Timestamps must be Dhaka local time**, formatted `yyyyMMddHHmmss`. A server running in UTC that
  formats `new Date()` gets rejected. `dhakaTimestamp()` is exported if you need it directly.
- **`X-KM-IP-V4` cannot be a loopback address.** `127.0.0.1` is swapped for a routable placeholder.
- **Keys can be bare base64.** The merchant portal hands you an unarmored key; PEM headers are added
  when missing.

One thing is genuinely ambiguous. Nagad's integration guide specifies **SHA1withRSA**, but the most
widely used Node and PHP implementations sign with **SHA256** and work in production, so accounts
appear to differ. The default is SHA256; if response signatures fail to verify, the error says so and
tells you to set `signatureAlgorithm: 'SHA1'`.

## Errors

Everything thrown is a `BdCommerceError` carrying a `code`, the `provider`, and the parsed
`response`.

```ts
import { BdCommerceError, ProviderError, ValidationError } from 'bd-commerce'

try {
  await steadfast.createOrder(input)
} catch (error) {
  if (error instanceof ValidationError) return badRequest(error.field)
  if (error instanceof ProviderError) return retryLater(error.response)
  if (BdCommerceError.is(error) && error.retryable) return queue.retry()
  throw error
}
```

| Class             | When                                                       |
| ----------------- | ---------------------------------------------------------- |
| `ConfigError`     | Client built with missing options                          |
| `ValidationError` | A local check failed; no request was sent. Carries `field` |
| `NetworkError`    | No response at all                                         |
| `TimeoutError`    | Aborted past `timeoutMs`                                   |
| `AuthError`       | HTTP 401 or 403                                            |
| `RateLimitError`  | HTTP 429, with `retryAfterMs` when the provider sent one   |
| `HttpError`       | Any other non-2xx                                          |
| `ProviderError`   | HTTP 200 carrying a business failure                       |

That last row matters more than it looks. Steadfast answers HTTP 200 with `status: 400` in the body,
and bKash answers HTTP 200 with `statusCode: "9999"`. A transport success is not a success, and
`ProviderError` is where that distinction lives.

## Retries and idempotency

GET requests retry twice by default with jittered exponential backoff, honouring `Retry-After`.

**Writes are never replayed.** Order creation and payment execution pass `retryable: false`, because
a retried `create_order` ships the parcel twice at the merchant's expense. Auth failures are not
retried either — see the Steadfast lockout above.

Tune per client with `timeoutMs`, `retries`, or pass your own `fetch`.

## Phone numbers

```ts
import { normalizeBdPhone, isBdPhone, toInternational } from 'bd-commerce'

normalizeBdPhone('+880 1712-345678') // '01712345678'
toInternational('01712345678') // '+8801712345678'
isBdPhone('01212345678') // false — retired prefix
```

Courier clients normalize recipient numbers automatically. Pass `validatePhone: false` if you already
do it upstream.

## Verification status

Request and response shapes were written from published merchant documentation and are covered by
226 unit tests against recorded payloads. Where they have been checked against the live APIs is
listed honestly below, because a payments library that overclaims is worse than one that admits its
gaps.

| Provider  | Confirmed against the live API                                                          | Not yet confirmed                                                                     |
| --------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Pathao    | Auth, stores, city/zone/area lists, price plan — all match these types exactly          | Order creation. The shared public sandbox merchant is in arrears and answers HTTP 402 |
| RedX      | Host, path prefix and `API-ACCESS-TOKEN` header — an invalid token returns 401, not 404 | Every success path; needs a merchant token                                            |
| Steadfast | The 401 shape, including the `attempts_left` lockout counter                            | Order creation and status lookups                                                     |
| bKash     | The error envelope, including a malformed-JSON body it really does return               | The whole success path                                                                |
| Nagad     | Nothing yet                                                                             | Everything; needs merchant onboarding and an RSA key pair                             |

Each provider has a smoke script that replays the real API and diffs every response key against the
types in this package:

```bash
pnpm run smoke:pathao      # needs nothing — Pathao publishes sandbox credentials
pnpm run smoke:bkash       # free sandbox credentials, no onboarding required
pnpm run smoke:redx        # needs your own token
pnpm run smoke:steadfast   # read-only by default; no sandbox exists
pnpm run smoke:nagad       # needs merchant onboarding
```

**If a field differs from what your merchant account returns, that is the most valuable issue you can
open.** `error.response` carries the raw payload verbatim; strip the customer's details and paste it.
`baseUrl` is overridable on every client in the meantime. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and PRs welcome, particularly from anyone with live merchant accounts who can confirm real
payloads. See [CONTRIBUTING.md](CONTRIBUTING.md) and [ROADMAP.md](ROADMAP.md).

## License

MIT © Md. Sabbir Howlader
