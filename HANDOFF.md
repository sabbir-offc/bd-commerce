# bd-commerce handoff

A running record of where this project stands. Updated as things happen, not at the end.

## Resume here

v0.1 is code-complete and green locally: 83 tests, typecheck clean, ESM + CJS + d.ts build.
Nothing has been published and no remote exists yet.

The next three things, in order:

1. **Verify against live credentials.** Everything here was written from published merchant docs.
   The bKash half has a script for this: `pnpm run smoke:bkash` (see `scripts/smoke-bkash.ts`). It
   drives the sandbox, records every exchange to `.smoke/` with secrets redacted, and diffs each
   response's keys against `src/bkash/types.ts`. Sandbox credentials are free and need no merchant
   onboarding. Steadfast has no sandbox, so that half still needs a real merchant account or a
   payload borrowed from someone who has one; `examples/steadfast-order.ts` is the script for it.
   Until both halves are confirmed, the README's verification note must stay.
2. **Create the GitHub repo** and push. `package.json` currently assumes
   `github.com/sabbir-offc/bd-commerce`; change it if the repo lands elsewhere.
3. **Check the npm name.** `bd-commerce` was assumed available, not confirmed. If it is taken,
   `@sabbir-offc/bd-commerce` is the fallback and the README install line changes with it.

## What exists

```
src/core/      errors.ts, http.ts, phone.ts     shared transport and validation
src/courier/   types.ts                          the Courier interface Pathao/RedX will implement
src/steadfast/ client.ts, status.ts, types.ts
src/bkash/     client.ts, token.ts, types.ts
test/          80 tests, no network, scripted fetch double in helpers.ts
examples/      steadfast-order.ts, bkash-checkout.ts
```

## Decisions worth not re-litigating

- **Zero runtime dependencies.** No zod, no axios. It is what makes the package safe to drop into
  an edge runtime, and validation here is shallow enough to hand-write.
- **Steadfast `*_approval_pending` maps to `in_review`, not to the outcome it names.** Those states
  can flip and the COD money has not moved. `pendingApproval` and `providerStatus` carry the detail
  for anyone who wants it. This is the single most valuable thing the package does.
- **Writes are never retried.** `createOrder` and `executePayment` pass `retryable: false`. A
  replayed create ships a second parcel at the merchant's cost.
- **bKash token cache is pluggable and defaults to memory.** Correct for a long-lived server, wrong
  for serverless, and the README says so rather than guessing at Redis.
- **Bulk create reports per row.** Steadfast fails rows individually; collapsing that into one
  throw would lose orders.

## Open

- **bKash signals auth failure inside an HTTP 200.** Confirmed against the sandbox: bad credentials
  come back as `statusCode: "9999"` with HTTP 200, not 401. The automatic re-grant-and-retry in
  `BkashClient.authed()` keys off `AuthError`, which only fires on 401/403, so it may never trigger
  in practice. Needs one observation with a genuinely expired id token to learn which code bKash
  uses for that, then the retry should key off the code instead.
- Idempotency on `createOrder` after a timeout: currently the caller's problem, documented in
  ROADMAP. A `getStatusByInvoice` probe before retry is probably the right guidance.
- pnpm 11 moved build-script approval to `pnpm-workspace.yaml` (`allowBuilds: esbuild: true`).
  Without it, esbuild has no binary and both tsup and vitest fail on a fresh clone.

## Log

- **2026-09-09** — Added `scripts/smoke-bkash.ts`. Running it against the sandbox with deliberately
  fake credentials found two real bugs, both fixed: bKash returns error bodies with a raw newline
  inside a JSON string value, which is not legal JSON, so `parseBody` fell back to raw text and a
  credential failure surfaced as a bogus "response contained no id_token"; and `assertOk` accepted
  a non-object body silently. `parseBody` now repairs unescaped control characters inside string
  literals, and `assertOk` rejects an unparseable body outright. 83 tests.
- **2026-09-09** — Scaffolded in `E:\Projects\bd-commerce`. Steadfast and bKash clients, shared
  HTTP and error layers, 80 tests, docs, CI workflow. Typecheck, tests, and build all pass. Not
  published, no git remote, not yet run against live credentials.
