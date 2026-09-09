/**
 * bKash sandbox smoke test.
 *
 * The point is not "does it return 200" — the unit tests already cover our
 * side. It is to capture what the real sandbox sends back and compare it, key
 * by key, against the types in `src/bkash/types.ts`. Those types were written
 * from documentation, so a missing or renamed field is the most likely defect
 * in this package.
 *
 * Every exchange is written to `.smoke/bkash-<timestamp>.json` with credentials
 * and tokens redacted, so a transcript can be pasted into an issue safely.
 *
 * Setup — sandbox credentials are free and need no merchant onboarding
 * (https://developer.bka.sh/docs/product-overview):
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
 * Sandbox wallet numbers, PINs and OTPs are published in bKash's own developer
 * docs and demo merchant portal (https://merchantdemo.sandbox.bka.sh). This
 * script deliberately does not hardcode them, because they change.
 */
import { BkashClient } from '../src/bkash/index.js'
import { BdCommerceError } from '../src/core/errors.js'
import {
  argv,
  createRecorder,
  field,
  flagValue,
  heading,
  reportShapeDrift,
  requireEnv,
  UsageError,
  writeTranscript,
  type KeySpec,
} from './lib/recorder.js'

/** Taken from `src/bkash/types.ts`. */
const EXPECTED: Record<string, KeySpec> = {
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
    optional: ['charge', 'completedTime'],
  },
}

const recorder = createRecorder({
  endpointOf,
  secretKeys: [
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
  ],
})

function main() {
  const [command, ...rest] = argv()

  const client = new BkashClient({
    appKey: requireEnv('BKASH_APP_KEY'),
    appSecret: requireEnv('BKASH_APP_SECRET'),
    username: requireEnv('BKASH_USERNAME'),
    password: requireEnv('BKASH_PASSWORD'),
    sandbox: true,
    fetch: recorder.fetchImpl,
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
  const amount = Number(flagValue(args, '--amount') ?? 100)
  const invoiceNumber = flagValue(args, '--invoice') ?? `SMOKE-${Date.now()}`
  const callbackURL = process.env.BKASH_CALLBACK_URL ?? 'https://example.com/api/bkash/callback'

  heading('Phase 1: create a payment')

  recorder.step('createPayment')
  const payment = await client.createPayment({ amount, invoiceNumber, callbackURL })

  field('paymentID', payment.paymentId)
  field('invoice', payment.invoiceNumber)
  field('amount', `${payment.amount} ${payment.currency}`)
  field('status', payment.transactionStatus)

  // Query before anyone has paid. Cheap, and it proves the query shape without
  // needing the browser step to have happened.
  recorder.step('queryPayment (before)')
  const state = await client.queryPayment(payment.paymentId)
  field('query says', state.transactionStatus)

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

  recorder.step('executePayment')
  const executed = await client.executePayment(paymentId)

  field('trxID', executed.trxId)
  field('status', executed.transactionStatus)
  field('amount', `${executed.amount} ${executed.currency}`)
  field('invoice', executed.invoiceNumber)
  field('msisdn', executed.customerMsisdn ?? '(not returned)')

  recorder.step('queryPayment (after)')
  const state = await client.queryPayment(paymentId)
  field('query says', state.transactionStatus)

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

  recorder.step('refund')
  const refund = await client.refund({
    paymentId,
    trxId,
    amount: Number(amount),
    sku: 'SMOKE-SKU',
    reason: 'smoke test',
  })

  field('refundTrxID', refund.refundTrxID)
  field('status', refund.transactionStatus)
  field('amount', `${refund.amount} ${refund.currency}`)
}

/** `.../tokenized/checkout/payment/status` becomes `payment/status`. */
function endpointOf(url: string): string {
  const marker = '/tokenized/checkout/'
  const index = url.indexOf(marker)
  return index === -1 ? url : url.slice(index + marker.length)
}

try {
  await main()
  const drifted = reportShapeDrift(recorder.transcript, EXPECTED)
  console.log(`\nTranscript: ${writeTranscript('bkash', recorder.transcript)}`)
  process.exit(drifted ? 1 : 0)
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`\n${error.message}\n`)
    process.exit(2)
  }

  console.error('\nFailed.')
  if (BdCommerceError.is(error)) {
    const code = error.providerCode ? ` ${error.providerCode}` : ''
    console.error(`  bkash ${error.code}${code}`)
    console.error(`  ${error.message}`)
  } else {
    console.error(error)
  }

  // A failed run is the interesting one; keep the transcript.
  reportShapeDrift(recorder.transcript, EXPECTED)
  console.error(`\nTranscript: ${writeTranscript('bkash', recorder.transcript)}`)
  process.exit(1)
}
