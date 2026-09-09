# bd-commerce handoff

A running record of where this project stands. Updated as things happen, not at the end.

## Resume here

v0.4 is code-complete and green: 226 tests, typecheck clean, ESM + CJS + d.ts build. Pushed to
https://github.com/sabbir-offc/bd-commerce (public). Not published to npm.

The next two things, in order:

1. **Verify against live credentials.** Everything here was written from published merchant docs.
   The bKash half has a script for this: `pnpm run smoke:bkash` (see `scripts/smoke-bkash.ts`). It
   drives the sandbox, records every exchange to `.smoke/` with secrets redacted, and diffs each
   response's keys against `src/bkash/types.ts`. Sandbox credentials are free and need no merchant
   onboarding. Steadfast has no sandbox, so that half still needs a real merchant account or a
   payload borrowed from someone who has one; `pnpm run smoke:steadfast` is read-only by default and
   is the script for it. `pnpm run smoke:pathao` needs nothing at all; `pnpm run smoke:redx` needs
   your own token. What is and is not confirmed is listed below; until every provider is covered,
   the README's verification note must stay.
2. **Check the npm name.** `bd-commerce` was assumed available, not confirmed. If it is taken,
   `@sabbir-offc/bd-commerce` is the fallback and the README install line changes with it.

## What exists

```
src/core/      errors.ts, http.ts, phone.ts     shared transport and validation
               token.ts                          shared by bKash and Pathao
src/courier/   types.ts                          the Courier interface the three couriers implement
src/steadfast/ client.ts, status.ts, types.ts
src/bkash/     client.ts, token.ts, types.ts
src/pathao/    client.ts, status.ts, types.ts
src/redx/      client.ts, status.ts, types.ts
src/nagad/     client.ts, crypto.ts, status.ts, types.ts   Node-only, off the root barrel
test/          226 tests, no network, scripted fetch double in helpers.ts
scripts/       smoke-{bkash,steadfast,pathao,redx,nagad}.ts, lib/recorder.ts (shared)
scripts/ci/    import-check.mjs, run against dist on every Node in engines
examples/      steadfast-order.ts, bkash-checkout.ts
```

## Decisions worth not re-litigating

- **Zero runtime dependencies.** No zod, no axios. It is what makes the package safe to drop into
  an edge runtime, and validation here is shallow enough to hand-write.
- **Steadfast `*_approval_pending` maps to `in_review`, not to the outcome it names.** Those states
  can flip and the COD money has not moved. `pendingApproval` and `providerStatus` carry the detail
  for anyone who wants it. This is the single most valuable thing the package does.
- **Writes are never retried.** `createOrder` and `executePayment` pass `retryable: false`. A
  replayed create ships a second parcel at the merchant's cost. Auth failures are not retried
  either, which matters more than it looks: see the Steadfast lockout below.
- **The Steadfast smoke test is read-only unless told otherwise.** There is no sandbox, so the
  default run cannot cost anything. Creating a consignment needs `--create --confirm-live`.
- **bKash token cache is pluggable and defaults to memory.** Correct for a long-lived server, wrong
  for serverless, and the README says so rather than guessing at Redis.
- **Bulk create reports per row.** Steadfast fails rows individually; collapsing that into one
  throw would lose orders.
- **`Courier` is generic, and three of its methods are optional.** Pathao needs numeric city and
  zone ids where Steadfast takes free text, and has no invoice lookup, tracking-code lookup or
  balance. Widening the shared input or faking the missing methods would only move the failure to
  runtime.
- **Pathao address resolution is explicit.** `resolveLocation` is a separate call and refuses an
  ambiguous name instead of guessing. A wrong zone is invisible until a parcel is on the wrong side
  of Dhaka.
- **The root barrel is written out by hand.** Steadfast, Pathao and RedX all export
  `toDeliveryStatus`, and Pathao and RedX both export `needsAttention`; a wildcard would leave
  which one you got down to file order.
- **RedX weight is `parcelWeightGrams` and rejects non-integers.** RedX uses grams, Pathao uses
  kilograms. Someone porting between them would otherwise pass `0.5` and ship a half-gram parcel.
- **RedX `createOrders` is sequential and validates everything first.** There is no batch endpoint,
  and a bad row partway through should not leave real parcels behind it.
- **Nagad is Node-only and stays off the root barrel.** WebCrypto has no RSAES-PKCS1-v1_5, so the
  client needs `node:crypto`. Exporting it from the root would cost every other consumer edge
  compatibility. `scripts/ci/import-check.mjs` asserts `NagadClient` is absent from the root, in
  both ESM and CJS, on every Node in `engines`.
- **`createPayment` runs both Nagad legs.** The challenge from initialize must be echoed in
  complete; splitting them would let a caller strand a payment reference that can never be used.

## Open

- **Nagad's signature algorithm is ambiguous.** Its integration guide says SHA1withRSA; the most
  used Node and PHP implementations use SHA256 and work in production. Default here is SHA256 with
  `signatureAlgorithm: 'SHA1'` as the escape hatch, and the verification error names it. A single
  live sandbox run settles this.
- **tsup rewrites `node:crypto` to a bare `crypto` in the output** and neither `platform: 'node'`
  nor dropping `treeshake` prevents it (both were tried and reverted; esbuild alone preserves the
  prefix, so it is tsup's own normalization). Harmless on Node, Bun and Deno; only relevant if
  someone tries the Nagad subpath under Workers `nodejs_compat`, where it does not work anyway.
  Not worth more effort unless someone reports it.

- **bKash signals auth failure inside an HTTP 200.** Confirmed against the sandbox: bad credentials
  come back as `statusCode: "9999"` with HTTP 200, not 401. The automatic re-grant-and-retry in
  `BkashClient.authed()` keys off `AuthError`, which only fires on 401/403, so it may never trigger
  in practice. Needs one observation with a genuinely expired id token to learn which code bKash
  uses for that, then the retry should key off the code instead.
- Idempotency on `createOrder` after a timeout: currently the caller's problem, documented in
  ROADMAP. A `getStatusByInvoice` probe before retry is probably the right guidance.
- pnpm 11 moved build-script approval to `pnpm-workspace.yaml` (`allowBuilds: esbuild: true`).
  Without it, esbuild has no binary and both tsup and vitest fail on a fresh clone.

## Confirmed against the live APIs

- **Node's `privateDecrypt` never throws on a mismatched RSA key** — measured 200/200 silently
  returning random bytes, which is the Marvin/Bleichenbacher implicit-rejection behaviour. The
  Nagad client's "your key pair does not match" message therefore keys off the JSON parse failing,
  not off a thrown decrypt. `test/nagad.test.ts` pins this so the branch is not "simplified" away.

- **RedX's host, path prefix and auth header are right** (2026-09-10). A single read-only probe against
  `sandbox.redx.com.bd/v1.0.0-beta/pickup/stores` with an invalid token returned 401, not 404, so
  the request shape is accepted and only the credential was rejected. Its error body carries
  `status_code`, and there is no `attempts_left` counter, so unlike Steadfast there is no lockout
  risk in testing.

- **Pathao's read surface matches these types exactly.** A full sandbox run on 2026-09-09 reported
  `ok` for `issue-token`, `stores`, `city-list`, `zone-list`, `area-list` and `price-plan`, after
  adding the pagination and price fields the first run flagged as extra.
- **Pathao's city list lives at `countries/1/city-list`.** A bare `city-list` 404s. This is the
  single most common mistake in third-party Pathao wrappers; the path here came from Pathao's own
  WooCommerce plugin.
- **Pathao order creation is still unconfirmed.** The shared public sandbox merchant is in arrears
  and answers HTTP 402, so the create payload has never been accepted. It needs a sandbox merchant
  in good standing. Everything else in the flow is verified.

- **Steadfast uses a real HTTP 401** for bad credentials, with the code mirrored in the body's
  `status`. Our `AuthError` mapping is correct for it. bKash does the opposite (see Open).
- **Steadfast rate-limits credential attempts.** A 401 carries `attempts_left`, counting down to a
  locked key. Auth failures are not retryable, so one bad call costs one attempt, and the count is
  now surfaced in the error message. Never point the smoke script at Steadfast with wrong keys.

## Log

- **2026-09-10** — Nagad client, 40 new tests, and `scripts/smoke-nagad.ts`. First provider that
  cannot run on the edge, which forced the root-barrel decision and a CI assertion to keep it
  honest. Tests generate a real RSA keypair and play both sides of the handshake rather than
  stubbing the crypto. Found and fixed an unreachable error branch: Node does not throw on a
  mismatched decryption key. 226 tests.

- **2026-09-10** — RedX client, 49 new tests, and `scripts/smoke-redx.ts`. Endpoint paths, the
  `API-ACCESS-TOKEN` header and both base URLs came from the codeboxr Laravel package's source
  rather than prose, then were confirmed live. The one genuinely dangerous difference from Pathao
  is the weight unit, handled by naming and by rejecting non-integers. 186 tests.

- **2026-09-09** — Pathao client, 51 new tests, and `scripts/smoke-pathao.ts`, which runs the whole
  sandbox flow with no human in the loop and no setup (it falls back to Pathao's published sandbox
  credentials). Building it forced two interface changes: `Courier` is now generic over its create
  input, and its invoice/tracking/balance methods are optional. Token handling moved to
  `src/core/token.ts`. The root barrel is explicit now that two providers export
  `toDeliveryStatus`. 137 tests.

- **2026-09-09** — Added `scripts/smoke-steadfast.ts` and pulled the shared recorder into
  `scripts/lib/recorder.ts`. The Steadfast script is read-only unless given both `--create` and
  `--confirm-live`, because there is no sandbox. A read-only run against the live API with invalid
  keys confirmed the 401 mapping and revealed `attempts_left`; the client now surfaces the count via
  a new `annotateError` hook on `HttpClient`. Also fixed the drift checker, which was comparing
  error bodies against the success spec and reporting drift that did not exist. 86 tests.
- **2026-09-09** — Repo created and pushed: https://github.com/sabbir-offc/bd-commerce (public).
- **2026-09-09** — Added `scripts/smoke-bkash.ts`. Running it against the sandbox with deliberately
  fake credentials found two real bugs, both fixed: bKash returns error bodies with a raw newline
  inside a JSON string value, which is not legal JSON, so `parseBody` fell back to raw text and a
  credential failure surfaced as a bogus "response contained no id_token"; and `assertOk` accepted
  a non-object body silently. `parseBody` now repairs unescaped control characters inside string
  literals, and `assertOk` rejects an unparseable body outright. 83 tests.
- **2026-09-09** — Scaffolded in `E:\Projects\bd-commerce`. Steadfast and bKash clients, shared
  HTTP and error layers, 80 tests, docs, CI workflow. Typecheck, tests, and build all pass. Not
  published, no git remote, not yet run against live credentials.
