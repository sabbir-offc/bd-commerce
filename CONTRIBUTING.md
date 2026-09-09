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

Steadfast has no sandbox, so its verification needs a real merchant account or a payload from
someone who has one.

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
