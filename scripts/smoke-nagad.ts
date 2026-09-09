/**
 * Nagad sandbox smoke test.
 *
 * Nagad publishes no shared sandbox credentials — you need a merchant id, an
 * account number and an RSA key pair either way. Put them in .env and this runs
 * against the sandbox host:
 *
 *   pnpm run smoke:nagad                    # create a payment, then verify it
 *   pnpm run smoke:nagad -- --verify <ref>  # verify an existing reference
 *   pnpm run smoke:nagad -- --live          # against production (see below)
 *
 * Creating against production needs `--live --confirm-live`. No money moves
 * until a shopper actually pays at the redirect URL, but it is still a real
 * transaction record on a real merchant account.
 *
 * A note on what this can and cannot check. Nagad's two checkout responses are
 * RSA envelopes — `{ sensitiveData, signature }` — so the transcript cannot be
 * key-diffed the way the other providers' can; the interesting fields are
 * inside the ciphertext. What the run does prove is the whole crypto handshake:
 * if `createPayment` returns a redirect URL, then the key pair, the padding,
 * the signature algorithm, the Dhaka timestamp and the challenge echo were all
 * accepted by Nagad. The `verify` endpoint is plaintext and is key-diffed
 * normally.
 */
import { NagadClient } from '../src/nagad/index.js'
import { BdCommerceError } from '../src/core/errors.js'
import {
  argv,
  createRecorder,
  field,
  flagValue,
  hasFlag,
  heading,
  reportShapeDrift,
  requireEnv,
  UsageError,
  writeTranscript,
  type KeySpec,
} from './lib/recorder.js'

/** Taken from `src/nagad/types.ts`. */
const EXPECTED: Record<string, KeySpec> = {
  'check-out/initialize': {
    required: ['sensitiveData', 'signature'],
    optional: ['reason', 'message', 'devMessage'],
  },
  'check-out/complete': {
    required: ['callBackUrl'],
    optional: ['status', 'message', 'reason', 'devMessage'],
  },
  'verify/payment': {
    required: ['status', 'statusCode'],
    optional: [
      'merchantId',
      'orderId',
      'paymentRefId',
      'amount',
      'clientMobileNo',
      'merchantMobileNo',
      'orderDateTime',
      'issuerPaymentDateTime',
      'issuerPaymentRefNo',
      'additionalMerchantInfo',
    ],
  },
}

const recorder = createRecorder({
  endpointOf,
  secretKeys: [
    // Ciphertext, but it is the merchant's data and there is no reason to ship
    // it in a bug report.
    'sensitiveData',
    'signature',
    'accountNumber',
    'clientMobileNo',
    'merchantMobileNo',
  ],
})

async function main() {
  const args = argv()
  const live = hasFlag(args, '--live')

  if (live && !hasFlag(args, '--confirm-live')) {
    throw new UsageError(
      '--live talks to production and creates a real transaction record.\n' +
        'Add --confirm-live once you are ready.',
    )
  }

  const client = new NagadClient({
    merchantId: requireEnv('NAGAD_MERCHANT_ID'),
    merchantNumber: requireEnv('NAGAD_MERCHANT_NUMBER'),
    merchantPrivateKey: requireEnv('NAGAD_PRIVATE_KEY'),
    nagadPublicKey: requireEnv('NAGAD_PUBLIC_KEY'),
    callbackUrl: process.env.NAGAD_CALLBACK_URL ?? 'https://example.com/api/nagad/callback',
    sandbox: !live,
    ...(process.env.NAGAD_SIGNATURE_ALGORITHM === 'SHA1'
      ? { signatureAlgorithm: 'SHA1' as const }
      : {}),
    fetch: recorder.fetchImpl,
  })

  heading(`Nagad ${live ? 'PRODUCTION' : 'sandbox'}`)
  field('signing', process.env.NAGAD_SIGNATURE_ALGORITHM === 'SHA1' ? 'SHA1' : 'SHA256 (default)')

  const existing = flagValue(args, '--verify')
  if (existing) {
    await verify(client, existing)
    return
  }

  const reference = await create(client)
  await verify(client, reference)
}

async function create(client: NagadClient): Promise<string> {
  heading('Create a payment')

  recorder.step('createPayment')
  const payment = await client.createPayment({
    orderId: `SMOKE-${Date.now()}`,
    amount: 10,
    productDetails: { note: 'bd-commerce smoke test' },
  })

  field('reference', payment.paymentReferenceId)
  field('order', payment.orderId)
  field('amount', `BDT ${payment.amount}`)

  console.log('\n  The handshake succeeded, which means Nagad accepted the key pair, the RSA')
  console.log('  padding, the signature algorithm, the Dhaka timestamp and the challenge echo.')
  console.log('\n  Pay at this URL to exercise the callback, then re-run with --verify:\n')
  console.log(`     ${payment.redirectUrl}\n`)
  console.log(`     pnpm run smoke:nagad -- --verify ${payment.paymentReferenceId}\n`)

  return payment.paymentReferenceId
}

async function verify(client: NagadClient, reference: string) {
  heading('Verify')

  recorder.step('verifyPayment')
  const verified = await client.verifyPayment(reference)

  field('outcome', verified.outcome)
  field('status', verified.providerStatus)
  field('statusCode', verified.statusCode ?? '(none)')
  field('amount', verified.amount ?? '(none)')
  field('trx', verified.issuerPaymentRefNo ?? '(not paid yet)')

  if (verified.outcome !== 'success') {
    console.log('\n  Not paid. That is expected for a payment nobody has completed —')
    console.log('  only `success` should ever mark an order paid.')
  }
}

/** `.../api/dfs/check-out/initialize/{merchant}/{order}` becomes the stem. */
function endpointOf(url: string): string {
  const marker = '/api/dfs/'
  const index = url.indexOf(marker)
  if (index === -1) return url

  const path = url.slice(index + marker.length).split('?')[0] ?? ''
  for (const known of ['check-out/initialize', 'check-out/complete', 'verify/payment']) {
    if (path === known || path.startsWith(`${known}/`)) return known
  }
  return path
}

try {
  await main()
  const drifted = reportShapeDrift(recorder.transcript, EXPECTED)
  console.log(`\nTranscript: ${writeTranscript('nagad', recorder.transcript)}`)
  process.exit(drifted ? 1 : 0)
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`\n${error.message}\n`)
    process.exit(2)
  }

  console.error('\nFailed.')
  if (BdCommerceError.is(error)) {
    const code = error.providerCode ? ` ${error.providerCode}` : ''
    console.error(`  nagad ${error.code}${code}`)
    console.error(`  ${error.message}`)
  } else {
    console.error(error)
  }

  reportShapeDrift(recorder.transcript, EXPECTED)
  console.error(`\nTranscript: ${writeTranscript('nagad', recorder.transcript)}`)
  process.exit(1)
}
