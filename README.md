# bd-commerce

Typed TypeScript clients for the infrastructure Bangladeshi e-commerce actually runs on.

Every F-commerce shop in Dhaka rewrites the same two integrations — Steadfast for cash-on-delivery
courier, bKash for payment — and most of those rewrites get the same things wrong: unsettled
delivery statuses treated as final, payments marked paid on a redirect that was never executed,
token grants fired per request until bKash rate-limits the merchant. This package is one careful
implementation of both, so you can stop writing the third one.

Covers **Steadfast**, **Pathao Courier**, **RedX**, and **bKash tokenized checkout**. Nagad is
next; see [ROADMAP.md](ROADMAP.md).

- Zero runtime dependencies. Native `fetch` only, so it runs on Node 18.17+, Bun, Deno, and edge runtimes.
- ESM and CJS, with full type declarations.
- Normalized results across providers, with the untouched provider payload kept on `raw`.
- One error hierarchy, with `retryable` set honestly.

## Install

```bash
pnpm add bd-commerce
```

## Steadfast

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
  note: 'Call before delivery',
})

order.consignmentId // '1424107'
order.trackingCode // '15BAEB8A'
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

### Delivery status, and the trap in it

Steadfast has four `*_approval_pending` statuses. They mean a rider reported an outcome that the
courier has **not settled** — it can still flip, and the COD money has not moved. Code that checks
`delivery_status === 'delivered'` against the raw API will mark orders paid that later come back.

This package maps all four to `in_review` and flags them:

```ts
const status = await steadfast.getStatusByInvoice('ORD-1042')

status.status // 'in_review'
status.pendingApproval // true
status.providerStatus // 'delivered_approval_pending' — the raw value, untouched

if (status.status === 'delivered') {
  // Only reached on a settled delivery.
  await settleOrder('ORD-1042')
}
```

If you want to show the unsettled outcome optimistically in a dashboard, `reportedStatus()` gives
you what the rider claimed without pretending it is final.

Also available: `getStatusByConsignmentId`, `getStatusByTrackingCode`, `getBalance`.

### Credential attempts are limited

Steadfast counts down `attempts_left` on every rejected credential and locks the API key when it
reaches zero. A typo in a production environment variable can lock a live merchant out of their own
courier, so this package puts the remaining count directly in the error and never retries an auth
failure:

```
steadfast: Unauthorized Access (invalid API credentials) — 9 credential attempts left before the key is locked
```

Do not test Steadfast with deliberately wrong keys.

## Pathao

Pathao needs two things Steadfast does not: a store, and an address expressed as numeric ids from
its own city/zone/area hierarchy.

```ts
import { PathaoClient } from 'bd-commerce/pathao'

const pathao = new PathaoClient({
  clientId: process.env.PATHAO_CLIENT_ID!,
  clientSecret: process.env.PATHAO_CLIENT_SECRET!,
  username: process.env.PATHAO_USERNAME!,
  password: process.env.PATHAO_PASSWORD!,
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
  itemWeight: 0.5, // kg — this sets the fee, so there is no default
})

order.consignmentId // 'DH210827A9QWE'
order.deliveryFee // 60
```

`resolveLocation` is a deliberate separate step rather than something `createOrder` does for you.
Silently picking the wrong zone sends a parcel to the wrong side of Dhaka, and that failure stays
invisible until it is expensive — so an unknown or ambiguous name throws, with the closest
candidates listed. Build your own picker with `listCities()`, `listZones(cityId)` and
`listAreas(zoneId)` if you would rather; all three are cached for the life of the client.

Quote before you commit:

```ts
const price = await pathao.calculatePrice({
  recipientCity: where.cityId,
  recipientZone: where.zoneId,
  itemWeight: 0.5,
})
price.final_price // 60
```

### Failed attempts are not "in transit"

Pathao reports `Pickup_Failed` and `Delivery_Failed`. Neither means the parcel is moving — nothing
happens until someone acts — so both normalize to `on_hold` rather than hiding inside `in_transit`
where a merchant filtering for active parcels would never see them again:

```ts
const status = await pathao.getStatusByConsignmentId(order.consignmentId)

if (status.status === 'on_hold') await escalate(order.invoice, status.providerStatus)
```

Also available: `createOrders` (bulk), `listStores`, `createStore`.

## RedX

RedX issues a long-lived merchant token rather than running an OAuth exchange, so there is nothing
to refresh. Its addresses are a flat area list, not Pathao's three-level hierarchy.

```ts
import { RedxClient } from 'bd-commerce/redx'

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

### Weight is in grams here

RedX measures parcels in **grams**; Pathao measures in **kilograms**. Porting an integration
between the two is the obvious way to ship a half-gram parcel and get charged for it. So the field
is named `parcelWeightGrams`, and a non-integer is rejected outright:

```ts
await redx.createOrder({ ...order, parcelWeightGrams: 0.5 })
// ValidationError: `parcelWeightGrams` must be a whole number of grams —
// RedX measures in grams, not kilograms — got 0.5
```

`createOrders` posts sequentially because RedX has no batch endpoint, and validates every row
before sending any of them — a bad row at index 40 should not leave 39 real parcels behind it.

Also available: `track` (full event timeline), `listAreas`, `listPickupStores`, `getPickupStore`.

## bKash

```ts
import { BkashClient } from 'bd-commerce/bkash'

const bkash = new BkashClient({
  appKey: process.env.BKASH_APP_KEY!,
  appSecret: process.env.BKASH_APP_SECRET!,
  username: process.env.BKASH_USERNAME!,
  password: process.env.BKASH_PASSWORD!,
  sandbox: process.env.NODE_ENV !== 'production',
})
```

Checkout is two steps, and the second one is the one that matters.

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

The redirect is shopper-controlled, so `status === 'success'` tells you which branch to take and
nothing more. `executePayment` is what proves the payment. If a callback never arrives — closed tab,
dropped network — reconcile with `queryPayment(paymentId)` rather than guessing.

Also available: `refund`, `searchTransaction`.

### Token caching in serverless

bKash rate-limits token grants. The default token store lives in process memory, which is right for
a long-running server and wrong for serverless, where every cold start grants again. Give it a
shared store there:

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

Concurrent calls in one process share a single grant, and an id token rejected mid-life is
re-granted and retried once automatically.

## What each courier supports

`Courier` is generic over its create input, because couriers genuinely differ: Steadfast takes a
free-text address, Pathao requires ids from its hierarchy. Optional methods are optional because
not every courier has them — probe with `await courier.getBalance?.()` rather than assuming.

|                               | Steadfast | Pathao                                            |
| ----------------------------- | --------- | ------------------------------------------------- |
| `createOrder`, `createOrders` | yes       | yes                                               |
| `getStatusByConsignmentId`    | yes       | yes                                               |
| `getStatusByInvoice`          | yes       | no                                                |
| `getStatusByTrackingCode`     | yes       | no (the consignment id is the tracking reference) |
| `getBalance`                  | yes       | no                                                |
| Address                       | free text | `resolveLocation` or city/zone/area ids           |
| Price quote before shipping   | no        | `calculatePrice`                                  |

## Errors

Everything thrown is a `BdCommerceError` with a `code`, the `provider`, and the parsed `response`.

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

| Class             | When                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `ConfigError`     | Client built with missing options                                                              |
| `ValidationError` | Local check failed; no request was sent                                                        |
| `NetworkError`    | No response at all                                                                             |
| `TimeoutError`    | Aborted past `timeoutMs`                                                                       |
| `AuthError`       | HTTP 401 or 403                                                                                |
| `RateLimitError`  | HTTP 429, with `retryAfterMs` when the provider sent one                                       |
| `HttpError`       | Any other non-2xx                                                                              |
| `ProviderError`   | HTTP 200 carrying a business failure — Steadfast `status != 200`, bKash `statusCode != '0000'` |

Both providers answer HTTP 200 for business failures, so a transport success is not a success.
`ProviderError` is where that distinction lives.

## Retries

GET requests retry twice by default with jittered exponential backoff, honouring `Retry-After`.
Order creation and payment execution are **never** replayed — a retried `create_order` ships the
parcel twice. Tune per client with `timeoutMs`, `retries`, or pass your own `fetch`.

## Phone numbers

```ts
import { normalizeBdPhone, isBdPhone, toInternational } from 'bd-commerce'

normalizeBdPhone('+880 1712-345678') // '01712345678'
toInternational('01712345678') // '+8801712345678'
isBdPhone('01212345678') // false — retired prefix
```

Courier clients normalize recipient numbers automatically. Pass `validatePhone: false` if you
already do it upstream.

## Verification status

The Steadfast and bKash request and response shapes here were written against published merchant
documentation and are covered by unit tests against recorded payloads. They have **not** yet been
run end to end against live merchant credentials. If a field name or endpoint path differs from what
your merchant account returns, open an issue with the raw payload — `error.response` carries it
verbatim — and it will be fixed quickly. `baseUrl` is overridable on both clients in the meantime.

Verified so far, by running the smoke scripts against the real APIs: Pathao's auth, stores,
city/zone/area lists and price plan all match the types here exactly, and RedX's host, path prefix
and auth header are confirmed (an invalid token returns 401, not 404). Pathao's order creation,
RedX's success paths, and everything on the Steadfast and bKash success paths are still unconfirmed
— those need credentials.

`pnpm run smoke:pathao`, `pnpm run smoke:redx`, `pnpm run smoke:bkash` and
`pnpm run smoke:steadfast` each report any drift between the live responses and the types in this
package. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and PRs welcome, particularly from anyone with live merchant accounts who can confirm real
payloads. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
