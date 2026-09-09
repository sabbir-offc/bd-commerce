/**
 * bKash sandbox smoke test.
 *
 * The point of this script is not "does it return 200" — the unit tests already
 * cover our side. It is to capture what the real sandbox actually sends back and
 * compare it, key by key, against the types in `src/bkash/types.ts`. Those types
 * were written from documentation, so a missing or renamed field is the most
 * likely defect in the package.
 *
 * Every exchange is written to `.smoke/bkash-<timestamp>.json` with credentials
 * and tokens redacted, so a transcript can be pasted into an issue safely.
 *
 * Setup (sandbox credentials are free and open to everyone, with no merchant
 * onboarding required — https://developer.bka.sh/docs/product-overview):
 *
 *   cp .env.example .env   # fill in the four BKASH_ values
 *
 * A payment needs a human in the middle, so this runs in two phases:
 *
 *   pnpm run smoke:bkash                        # create + query, prints a URL
 *   # open the URL, pay with a sandbox wallet, note the paymentID
 *   pnpm run smoke:bkash -- --execute <paymentID>
 *
 * Optional third phase, once you have a trxID from the execute:
 *
 *   pnpm run smoke:bkash -- --refund <paymentID> <trxID> <amount>
 *
 * Sandbox wallet numbers, PINs, and OTPs are published in bKash's own developer
 * docs and demo merchant portal (https://merchantdemo.sandbox.bka.sh). This
 * script deliberately does not hardcode them, because they change.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BkashClient } from '../src/bkash/index.js'
import { BdCommerceError } from '../src/core/errors.js'
import type { FetchLike } from '../src/core/http.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Keys each response is expected to carry, taken from `src/bkash/types.ts`.
 * Optional fields live in `optional` so their absence is not reported as drift.
 */
const EXPECTED: Record<string, { required: string[]; optional: string[] }> = {
  'token/grant': {
    required: ['id_token', 'token_type', 'expires_in', 'refresh_token'],
    optional: ['statusCode', 'statusMessage', 'errorCode', 'errorMessage'],
  },
  create: {
    required: [
      'paymentID',
      'bkashURL',
      'callbackURL',
      'amount',
      'intent',
      'currency',
      'paymentCreateTime',
      'transactionStatus',
      'merchantInvoiceNumber',
      'statusCode',
      'statusMessage',
    ],
    optional: ['successCallbackURL', 'failureCallbackURL', 'cancelledCallbackURL', 'agreementID'],
  },
  execute: {
    required: [
      'paymentID',
      'trxID',
      'transactionStatus',
      'amount',
      'currency',
      'intent',
      'paymentExecuteTime',
      'merchantInvoiceNumber',
      'statusCode',
      'statusMessage',
    ],
    optional: ['payerReference', 'customerMsisdn', 'agreementID'],
  },
  'payment/status': {
    required: [
      'paymentID',
      'mode',
      'paymentCreateTime',
      'amount',
      'currency',
      'intent',
      'merchantInvoiceNumber',
      'transactionStatus',
      'statusCode',
      'statusMessage',
    ],
    optional: ['trxID', 'payerReference', 'userVerificationStatus', 'verificationStatus'],
  },
  'payment/refund': {
    required: [
      'originalTrxID',
      'refundTrxID',
      'transactionStatus',
      'amount',
      'currency',
      'statusCode',
      'statusMessage',
    ],
    optional: ['charge', 'completedTime', 'currency'],
  },
}

interface Exchange {
  step: string
  endpoint: string
  method: string
  url: string
  requestBody: unknown
  status: number
  responseBody: unknown
  durationMs: number
}

const transcript: Exchange[] = []
let currentStep = 'setup'

/** Wraps fetch so every call is recorded, with secrets masked on the way in. */
const recordingFetch: FetchLike = async (url, init = {}) => {
  const startedAt = Date.now()
  const response = await fetch(url, init)
  const clone = response.clone()
  const text = await clone.text()

  transcript.push({
    step: currentStep,
    endpoint: endpointOf(url),
    method: init.method ?? 'GET',
    url,
    requestBody: redact(parseMaybeJson(typeof init.body === 'string' ? init.body : undefined)),
    status: response.status,
    responseBody: redact(parseMaybeJson(text)),
    durationMs: Date.now() - startedAt,
  })

  return response
}

function main() {
  // pnpm forwards the `--` separator through to argv, so drop it.
  const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--')

  const client = new BkashClient({
    appKey: requireEnv('BKASH_APP_KEY'),
    appSecret: requireEnv('BKASH_APP_SECRET'),
    username: requireEnv('BKASH_USERNAME'),
    password: requireEnv('BKASH_PASSWORD'),
    sandbox: true,
    fetch: recordingFetch,
  })

  switch (command) {
    case undefined:
    case '--create':
      return phaseCreate(client, rest)
    case '--execute':
      return phaseExecute(client, rest)
    case '--refund':
      return phaseRefund(client, rest)
    default:
      throw new UsageError(`Unknown argument "${command}"`)
  }
}

async function phaseCreate(client: BkashClient, args: string[]) {
  const amount = Number(valueFor(args, '--amount') ?? 100)
  const invoiceNumber = valueFor(args, '--invoice') ?? `SMOKE-${Date.now()}`
  const callbackURL = process.env.BKASH_CALLBACK_URL ?? 'https://example.com/api/bkash/callback'

  heading('Phase 1: create a payment')

  currentStep = 'createPayment'
  const payment = await client.createPayment({ amount, invoiceNumber, callbackURL })

  console.log(`  paymentID   ${payment.paymentId}`)
  console.log(`  invoice     ${payment.invoiceNumber}`)
  console.log(`  amount      ${payment.amount} ${payment.currency}`)
  console.log(`  status      ${payment.transactionStatus}`)

  // Query before anyone has paid. Cheap, and it proves the query shape without
  // needing the browser step to have happened.
  currentStep = 'queryPayment(before)'
  const state = await client.queryPayment(payment.paymentId)
  console.log(`  query says  ${state.transactionStatus}`)

  heading('Next')
  console.log('  1. Open this URL and pay with a sandbox wallet:\n')
  console.log(`     ${payment.bkashUrl}\n`)
  console.log('     Sandbox wallet numbers, PIN and OTP are in the bKash developer docs.')
  console.log(`  2. You will land on ${callbackURL} with paymentID and status in the query string.`)
  console.log('  3. Then finish the run:\n')
  console.log(`     pnpm run smoke:bkash -- --execute ${payment.paymentId}\n`)
  console.log('  The payment expires within a few minutes, so do not leave it sitting.')
}

async function phaseExecute(client: BkashClient, args: string[]) {
  const paymentId = args[0]
  if (!paymentId) throw new UsageError('--execute needs a paymentID')

  heading('Phase 2: execute the payment')

  currentStep = 'executePayment'
  const executed = await client.executePayment(paymentId)

  console.log(`  trxID       ${executed.trxId}`)
  console.log(`  status      ${executed.transactionStatus}`)
  console.log(`  amount      ${executed.amount} ${executed.currency}`)
  console.log(`  invoice     ${executed.invoiceNumber}`)
  console.log(`  msisdn      ${executed.customerMsisdn ?? '(not returned)'}`)

  currentStep = 'queryPayment(after)'
  const state = await client.queryPayment(paymentId)
  console.log(`  query says  ${state.transactionStatus}`)

  heading('Next')
  console.log('  To exercise a refund:\n')
  console.log(
    `     pnpm run smoke:bkash -- --refund ${paymentId} ${executed.trxId} ${executed.amount}\n`,
  )
}

async function phaseRefund(client: BkashClient, args: string[]) {
  const [paymentId, trxId, amount] = args
  if (!paymentId || !trxId || !amount) {
    throw new UsageError('--refund needs <paymentID> <trxID> <amount>')
  }

  heading('Phase 3: refund')

  currentStep = 'refund'
  const refund = await client.refund({
    paymentId,
    trxId,
    amount: Number(amount),
    sku: 'SMOKE-SKU',
    reason: 'smoke test',
  })

  console.log(`  refundTrxID ${refund.refundTrxID}`)
  console.log(`  status      ${refund.transactionStatus}`)
  console.log(`  amount      ${refund.amount} ${refund.currency}`)
}

/**
 * The actual verification: does the sandbox return what our types promise?
 * Missing required keys are defects in this package. Unknown keys are usually
 * harmless additions, but worth reading once.
 */
function reportShapeDrift(): boolean {
  heading('Response shape vs src/bkash/types.ts')

  let drifted = false
  for (const exchange of transcript) {
    const expected = EXPECTED[exchange.endpoint]
    if (!expected) continue
    if (!exchange.responseBody || typeof exchange.responseBody !== 'object') continue

    const actual = Object.keys(exchange.responseBody as Record<string, unknown>)
    const missing = expected.required.filter((key) => !actual.includes(key))
    const unknown = actual.filter(
      (key) => !expected.required.includes(key) && !expected.optional.includes(key),
    )

    const verdict = missing.length ? 'DRIFT' : unknown.length ? 'extra' : 'ok'
    console.log(`  ${pad(verdict, 6)} ${pad(exchange.endpoint, 16)} ${exchange.step}`)
    if (missing.length) {
      drifted = true
      console.log(`         missing: ${missing.join(', ')}`)
    }
    if (unknown.length) {
      console.log(`         unknown: ${unknown.join(', ')}`)
    }
  }

  if (drifted) {
    console.log('\n  Missing keys mean the types in this package are wrong, not the sandbox.')
    console.log('  Fix src/bkash/types.ts and the client mapping, then re-run.')
  }
  return drifted
}

function writeTranscript(): string {
  const dir = join(ROOT, '.smoke')
  mkdirSync(dir, { recursive: true })

  const path = join(dir, `bkash-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(path, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8')
  return path
}

// Anything that could identify or authenticate. The transcript is meant to be
// shareable in a bug report without a second thought.
const SECRET_KEYS = new Set([
  'app_key',
  'app_secret',
  'password',
  'username',
  'id_token',
  'refresh_token',
  'authorization',
  'x-app-key',
  'customerMsisdn',
  'payerReference',
])

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEYS.has(key) ? mask(nested) : redact(nested)
  }
  return result
}

function mask(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  // Keep enough to tell two values apart without revealing either.
  return text.length <= 8 ? '[redacted]' : `[redacted:${text.length}:...${text.slice(-4)}]`
}

function endpointOf(url: string): string {
  const marker = '/tokenized/checkout/'
  const index = url.indexOf(marker)
  return index === -1 ? url : url.slice(index + marker.length)
}

function parseMaybeJson(text: string | undefined): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new UsageError(
      `${name} is not set. Copy .env.example to .env and fill in the four sandbox values; \`pnpm run smoke:bkash\` loads .env automatically.`,
    )
  }
  return value
}

function valueFor(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`)
}

function pad(text: string, width: number): string {
  return text.padEnd(width, ' ')
}

class UsageError extends Error {}

try {
  await main()
  const drifted = reportShapeDrift()
  console.log(`\nTranscript: ${writeTranscript()}`)
  process.exit(drifted ? 1 : 0)
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`\n${error.message}\n`)
    process.exit(2)
  }

  console.error('\nFailed.')
  if (BdCommerceError.is(error)) {
    console.error(
      `  ${error.provider} ${error.code}${error.providerCode ? ` ${error.providerCode}` : ''}`,
    )
    console.error(`  ${error.message}`)
  } else {
    console.error(error)
  }

  // A failed run is the interesting one; keep the transcript.
  reportShapeDrift()
  console.error(`\nTranscript: ${writeTranscript()}`)
  process.exit(1)
}
