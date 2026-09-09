# Roadmap

The point of this package is to become the default way a Bangladeshi shop talks to its courier and
its payment gateway. That means shipping narrow and correct before shipping wide.

## v0.1 — shipped

- Steadfast: create, bulk create, three status lookups, balance.
- bKash tokenized checkout: create, execute, query, refund, search, callback parsing.
- Shared HTTP layer, error hierarchy, BD phone normalization.

## v0.2 — Pathao (shipped)

Auth (both the documented password grant and the client-credentials login Pathao's own WooCommerce
plugin uses), orders, bulk orders, order info, stores, the city/zone/area hierarchy with caching,
and price plans.

The open question from v0.1 is settled: address resolution stays an explicit step. `resolveLocation`
turns names into ids and refuses ambiguity rather than guessing, because a silently wrong zone is
invisible until a parcel is on the wrong side of Dhaka. `createOrder` takes ids only.

Two things fell out of building it. `Courier` is now generic over its create input, since Pathao
genuinely needs more than a free-text address and pretending otherwise only fails at runtime. And
`getStatusByInvoice`, `getStatusByTrackingCode` and `getBalance` are now optional, because Pathao
has none of them.

## v0.3 — RedX (shipped)

Parcels, sequential bulk, parcel info, the tracking timeline, a cached area list with
`resolveArea`, and pickup stores.

Simpler than Pathao in two ways — a static token instead of OAuth, and a flat area list instead of
a three-level hierarchy — and sharper in one: RedX measures weight in **grams** where Pathao uses
kilograms. `parcelWeightGrams` says so in the name and rejects non-integers, so `0.5` meaning half
a kilo fails loudly instead of shipping a half-gram parcel.

RedX has no batch endpoint, so `createOrders` posts sequentially. It validates every row before
sending any, because a bad row partway through should not leave real parcels behind it.

## v0.4 — Nagad

Nagad's checkout uses RSA signing of the sensitive payload rather than a bearer token, so it needs
key handling that the bKash client does not. Worth doing only once bKash has been confirmed against
live credentials, because the same execute-versus-redirect trap applies.

## Not planned

- A hosted service, a dashboard, or anything with a database. This is a client library.
- Framework adapters. `parseCallback` accepts whatever your framework hands you; that is enough.
- Webhook receivers. Signature schemes differ per provider and per merchant contract, and getting
  that wrong silently is worse than not shipping it.

## Open questions

- Should `createOrder` accept an idempotency key and dedupe locally? Steadfast rejects duplicate
  invoices, which covers most of it, but a timeout on the first attempt leaves the caller unsure.
  A `getStatusByInvoice` probe before retrying may be the honest answer, documented rather than
  automatic.
- Whether to expose a `reconcile()` helper that pairs a bKash `queryPayment` with an order lookup.
  Useful, but it needs an opinion about the caller's data model that a client library should not have.
