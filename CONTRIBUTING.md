# Contributing

## Setup

```bash
pnpm install
pnpm run check   # typecheck, test, build
```

Tests never touch the network, so `pnpm run check` works with no credentials at all.

## The most useful contribution right now

**A real response payload from a live merchant account.**

Every request and response shape in this package was written from published merchant documentation.
Some of it has since been confirmed against the live APIs; most of the success paths have not. The
[verification table in the README](README.md#verification-status) says exactly which. Closing those
gaps matters more than any new feature.

You do not need to write code to help. One real `create_order` response, or one status lookup, with
the customer's details replaced, settles the field names for everyone.

### Sending a payload safely

Every error carries the raw provider response:

```ts
catch (error) {
  if (BdCommerceError.is(error)) console.error(error.provider, error.code, error.response)
}
```

**Redact before posting:** API keys and tokens, customer names, phone numbers, addresses, and your
merchant or account numbers. Replace them with obvious placeholders rather than deleting the fields,
so the shape stays readable.

## Smoke scripts

Each provider has a script that replays the real API, records every exchange to `.smoke/` with
secrets and customer data already masked, and diffs each response's keys against this package's
types. A `DRIFT` line means **this package is wrong**, and that is the bug worth reporting.

Ordered by how much you need to start:

| Provider  | What you need                                                     | Safe to run repeatedly                     |
| --------- | ----------------------------------------------------------------- | ------------------------------------------ |
| Pathao    | Nothing — it falls back to Pathao's published sandbox credentials | Yes, sandbox                               |
| bKash     | Free sandbox credentials, no merchant onboarding                  | Yes, sandbox                               |
| RedX      | Your own merchant token                                           | Yes against the sandbox host               |
| Steadfast | A merchant account; there is no sandbox                           | **Read-only only** — see the warning below |
| Nagad     | Merchant onboarding and an RSA key pair                           | Yes, sandbox                               |

Copy `.env.example` to `.env` and fill in whatever you have.

### Pathao — start here

Needs no setup whatsoever:

```bash
pnpm run smoke:pathao              # auth, stores, hierarchy, price, order, read-back
pnpm run smoke:pathao -- --no-create
```

### bKash

Sandbox credentials are free and open to everyone before onboarding:

```bash
pnpm run smoke:bkash                        # create + query, prints a URL to pay at
pnpm run smoke:bkash -- --execute <paymentID>
```

### RedX

Read-only by default. Creating against production takes three deliberate flags:

```bash
pnpm run smoke:redx                  # areas + pickup stores
pnpm run smoke:redx -- --create      # plus a sandbox parcel
pnpm run smoke:redx -- --live --create --confirm-live
```

### Steadfast — read the warning

Steadfast has no sandbox. Every call is live, and `create_order` produces a real consignment a rider
can collect. The default run is therefore strictly read-only:

```bash
pnpm run smoke:steadfast                        # balance only, no writes
pnpm run smoke:steadfast -- --invoice ORD-1042  # plus a status lookup
```

That alone checks credentials, the base URL, the response envelope, and the balance and status
shapes. Creating a consignment needs two deliberate flags, and should be cancelled in the merchant
portal afterwards:

```bash
pnpm run smoke:steadfast -- --create --confirm-live --name "..." --phone 01... --address "..."
```

> **Never run it with deliberately wrong credentials.** Steadfast counts down `attempts_left` on
> every rejected credential and locks the API key at zero. One careless test can lock a real merchant
> out of their own courier.

### Nagad

```bash
pnpm run smoke:nagad                    # create a payment, then verify it
pnpm run smoke:nagad -- --verify <ref>  # after paying at the redirect URL
```

Nagad's two checkout responses are RSA envelopes, so the transcript cannot be key-diffed the way the
others can — the interesting fields are inside the ciphertext. What a successful run does prove is
the entire crypto handshake: a redirect URL comes back only if the key pair, the padding, the
signature algorithm, the Dhaka timestamp and the challenge echo were all accepted.

## Adding a provider

Couriers implement `Courier` from `src/courier/types.ts`, which is generic over its create input.
Do not widen the shared input to fit a new provider, and do not implement a method the provider does
not really have — `getStatusByInvoice`, `getStatusByTrackingCode` and `getBalance` are optional
precisely because Pathao and RedX lack them.

The rules that make the existing clients worth using:

1. **Normalize, never discard.** Map the provider's vocabulary onto the shared types and keep the
   original on `raw` and `providerStatus`.
2. **A 200 is not a success.** Steadfast answers HTTP 200 with `status: 400` in the body; bKash
   answers HTTP 200 with `statusCode: "9999"`. Check the envelope and throw `ProviderError`.
3. **Never replay a write.** Pass `retryable: false` for anything that creates an order or moves
   money. A duplicate parcel costs a real merchant real money.
4. **Do not report an unsettled outcome as final.** Where a provider distinguishes "reported" from
   "settled", the normalized status must reflect the settled one. Where it distinguishes "moving"
   from "stuck", a failed attempt must not read as in transit.
5. **Validate locally before spending a request**, and put the field name on the `ValidationError`.
6. **Name a unit when providers disagree about it.** `parcelWeightGrams` exists because RedX uses
   grams and Pathao uses kilograms.

New providers get their own subpath in `package.json` `exports` and their own tsup entry. If a
provider needs a Node builtin, keep it off the package root the way `nagad` is, so the rest stays
edge-safe.

## Tests

No network, ever. `test/helpers.ts` provides a scripted fetch double that records calls; every new
endpoint should assert both the request it sends and the shape it returns.

Recorded payloads should be real ones with identifying details replaced — the Steadfast
`attempts_left` test and the Nagad handshake tests are built from genuinely observed responses, which
is what makes them worth having. Where crypto is involved, generate real keys in the test rather than
stubbing it; that is how the Node decryption bug in `src/nagad/client.ts` was found.

## Style

Prettier, no semicolons, single quotes, 100 columns. Run `pnpm run format` before committing; CI runs
`format:check` and will fail on unformatted code.

## Releases

Maintainers only. Bump `version` in `package.json`, date the changelog section, then push a matching
`v*` tag — `.github/workflows/release.yml` publishes from CI with provenance and refuses a tag that
does not match `package.json`. Never publish from a laptop.
