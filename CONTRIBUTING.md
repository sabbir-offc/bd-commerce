# Contributing

## Setup

```bash
pnpm install
pnpm run check   # typecheck, test, build
```

## What is most useful right now

Confirmed payloads from live merchant accounts. The v0.1 clients were written against published
documentation, not against a production Steadfast or bKash account. If a response you get differs
from what the types here say, that is the highest-value issue you can open.

For bKash there is a script that does this for you:

```bash
cp .env.example .env    # fill in the four BKASH_ sandbox values
pnpm run smoke:bkash    # create + query, prints a URL to pay at
pnpm run smoke:bkash -- --execute <paymentID>
```

It records every exchange to `.smoke/` with credentials, tokens, and customer numbers redacted, and
diffs each response's keys against `src/bkash/types.ts`. A `DRIFT` line means this package's types
are wrong. Sandbox credentials are free and do not require merchant onboarding.

Pathao has a real sandbox and its script needs no setup at all — it falls back to the sandbox
credentials Pathao publishes in its own docs:

```bash
pnpm run smoke:pathao              # auth, stores, hierarchy, price, order, read-back
pnpm run smoke:pathao -- --no-create
```

RedX has a sandbox but publishes no shared credentials, so its script needs your own token. It is
read-only by default, and creating against production takes three flags:

```bash
pnpm run smoke:redx                  # areas + pickup stores
pnpm run smoke:redx -- --create      # plus a sandbox parcel
pnpm run smoke:redx -- --live --create --confirm-live
```

Steadfast has no sandbox — every call is live — so its script defaults to read-only:

```bash
pnpm run smoke:steadfast                        # balance only, no writes
pnpm run smoke:steadfast -- --invoice ORD-1042  # plus a status lookup
```

That already checks credentials, the base URL, the response envelope, and the balance and status
shapes. Creating a real consignment needs two deliberate flags and should be cancelled in the
merchant portal afterwards:

```bash
pnpm run smoke:steadfast -- --create --confirm-live --name "..." --phone 01... --address "..."
```

**Do not run it with deliberately wrong credentials.** Steadfast counts down `attempts_left` and
locks the API key at zero.

No merchant account? You can still help: one real `create_order` response and one status response,
with the customer's details replaced, settles the field names.

Include the raw payload. Every error thrown carries it on `error.response`:

```ts
catch (error) {
  if (BdCommerceError.is(error)) console.error(error.provider, error.code, error.response)
}
```

Redact credentials, phone numbers, and addresses first.

## Adding a provider

Couriers implement `Courier` from `src/courier/types.ts`. The rules that make the existing clients
worth using:

1. **Normalize, never discard.** Map the provider's vocabulary onto the shared types and keep the
   original on `raw` and `providerStatus`.
2. **A 200 is not a success.** Both providers so far report business failures inside a 200 body.
   Check the envelope and throw `ProviderError`.
3. **Never replay a write.** Pass `retryable: false` for anything that creates an order or moves
   money. A duplicate parcel costs a real merchant real money.
4. **Do not report an unsettled outcome as final.** If the provider distinguishes "reported" from
   "settled", the normalized status must reflect the settled one.
5. **Validate locally before spending a request**, and put the field name on the `ValidationError`.

## Tests

No network. `test/helpers.ts` provides a scripted fetch double that records calls; every new
endpoint should assert both the request it sends and the shape it returns. Recorded payloads in
tests should be real ones with identifying details replaced.

## Style

Prettier, no semicolons, single quotes, 100 columns. `pnpm run format` before committing.
