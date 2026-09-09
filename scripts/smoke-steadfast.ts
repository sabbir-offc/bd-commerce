/**
 * Steadfast smoke test.
 *
 * Steadfast has no sandbox. Every request this script makes goes to the live
 * merchant API, and `create_order` produces a real consignment that a rider can
 * turn up to collect. So the default run is strictly read-only, and creating an
 * order takes two deliberate flags.
 *
 *   pnpm run smoke:steadfast                            # balance only, no writes
 *   pnpm run smoke:steadfast -- --invoice ORD-1042      # plus a status lookup
 *   pnpm run smoke:steadfast -- --cid 1424107
 *   pnpm run smoke:steadfast -- --tracking 15BAEB8A
 *
 * The read-only run already verifies credentials, the base URL, the response
 * envelope, and the balance and status shapes. That is most of the surface with
 * none of the risk. Do that first.
 *
 * To verify `createOrder`, which is the one call that costs something:
 *
 *   pnpm run smoke:steadfast -- --create --confirm-live --name "..." --phone 01... --address "..."
 *
 * Cancel the consignment in the merchant portal afterwards. A COD amount of 0
 * is the default so nothing is collected even if it does ship.
 *
 * If you do not have a merchant account, you do not need one to help: a single
 * real create_order and status response, with the customer's details replaced,
 * settles the field names. Every exchange here is written to `.smoke/` with
 * credentials and recipient details already masked.
 */
import { SteadfastClient } from '../src/steadfast/index.js'
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

/** Taken from `src/steadfast/types.ts`. */
const EXPECTED: Record<string, KeySpec> = {
  create_order: {
    required: ['status', 'message'],
    nested: {
      consignment: {
        required: [
          'consignment_id',
          'invoice',
          'tracking_code',
          'recipient_name',
          'recipient_phone',
          'recipient_address',
          'cod_amount',
          'status',
          'note',
        ],
        optional: ['created_at', 'updated_at', 'id', 'recipient_email', 'alternative_phone'],
      },
    },
  },
  status_by_cid: { required: ['status', 'delivery_status'], optional: ['message'] },
  status_by_invoice: { required: ['status', 'delivery_status'], optional: ['message'] },
  status_by_trackingcode: { required: ['status', 'delivery_status'], optional: ['message'] },
  get_balance: { required: ['status', 'current_balance'], optional: ['message'] },
}

const recorder = createRecorder({
  endpointOf,
  secretKeys: [
    'api-key',
    'secret-key',
    // Recipient details are a real person's, even in a test order.
    'recipient_name',
    'recipient_phone',
    'recipient_address',
    'recipient_email',
    'alternative_phone',
  ],
})

async function main() {
  const args = argv()

  // Check the write guard before anything talks to the network, so a missing
  // flag costs nothing.
  if (hasFlag(args, '--create')) assertCreateAllowed(args)

  const client = new SteadfastClient({
    apiKey: requireEnv('STEADFAST_API_KEY'),
    secretKey: requireEnv('STEADFAST_SECRET_KEY'),
    fetch: recorder.fetchImpl,
  })

  await readOnlyChecks(client, args)

  if (hasFlag(args, '--create')) {
    await createCheck(client, args)
  } else {
    heading('Not run')
    console.log('  createOrder was skipped. It creates a real consignment, so it needs')
    console.log('  both --create and --confirm-live. See the header of this file.')
  }
}

async function readOnlyChecks(client: SteadfastClient, args: string[]) {
  heading('Read-only checks')

  recorder.step('getBalance')
  const balance = await client.getBalance()
  field('balance', `BDT ${balance.currentBalance}`)

  const lookups: Array<[string, string | undefined, (value: string) => Promise<unknown>]> = [
    ['invoice', flagValue(args, '--invoice'), (v) => client.getStatusByInvoice(v)],
    ['consignment', flagValue(args, '--cid'), (v) => client.getStatusByConsignmentId(v)],
    ['tracking', flagValue(args, '--tracking'), (v) => client.getStatusByTrackingCode(v)],
  ]

  let ran = 0
  for (const [label, value, lookup] of lookups) {
    if (!value) continue
    ran++

    recorder.step(`status by ${label}`)
    const status = (await lookup(value)) as {
      status: string
      providerStatus: string
      pendingApproval: boolean
    }
    field(label, value)
    field('status', status.status)
    field('provider', status.providerStatus)
    field('pending', status.pendingApproval ? 'yes — outcome not settled' : 'no')
  }

  if (ran === 0) {
    console.log('\n  No status lookup requested. Pass --invoice, --cid or --tracking with a')
    console.log('  reference from an order you have already shipped to check those shapes too.')
  }
}

/** Everything that can be rejected without spending a request. */
function assertCreateAllowed(args: string[]): void {
  if (!hasFlag(args, '--confirm-live')) {
    throw new UsageError(
      'Steadfast has no sandbox: --create makes a real consignment that a rider may collect.\n' +
        'Re-run with --confirm-live once you are ready, and cancel it in the merchant portal after.',
    )
  }
  if (!flagValue(args, '--name') || !flagValue(args, '--phone') || !flagValue(args, '--address')) {
    throw new UsageError('--create needs --name, --phone and --address. Use your own details.')
  }
}

async function createCheck(client: SteadfastClient, args: string[]) {
  const name = flagValue(args, '--name') as string
  const phone = flagValue(args, '--phone') as string
  const address = flagValue(args, '--address') as string

  const invoice = flagValue(args, '--invoice-ref') ?? `SMOKE-${Date.now()}`
  const codAmount = Number(flagValue(args, '--cod') ?? 0)

  heading('Creating a REAL consignment')
  field('invoice', invoice)
  field('cod', `BDT ${codAmount}`)
  field('to', `${name} (details are masked in the transcript)`)
  console.log('\n  Cancel this in the merchant portal when you are done.\n')

  recorder.step('createOrder')
  const order = await client.createOrder({
    invoice,
    recipientName: name,
    recipientPhone: phone,
    recipientAddress: address,
    codAmount,
    note: 'bd-commerce smoke test — please cancel',
  })

  field('consignment', order.consignmentId)
  field('tracking', order.trackingCode)
  field('status', `${order.status} (${order.providerStatus})`)

  // Read it straight back. This is the pairing that matters: the status
  // endpoint has to agree with what create just told us.
  recorder.step('status by consignment (after create)')
  const status = await client.getStatusByConsignmentId(order.consignmentId)
  field('re-read', `${status.status} (${status.providerStatus})`)
}

/** `.../api/v1/status_by_cid/1424107` becomes `status_by_cid`. */
function endpointOf(url: string): string {
  const marker = '/api/v1/'
  const index = url.indexOf(marker)
  const path = index === -1 ? url : url.slice(index + marker.length)
  const [head = path, tail] = path.split('/')
  // `create_order/bulk-order` keeps both segments; identifiers are dropped.
  return tail === 'bulk-order' ? `${head}/${tail}` : head
}

try {
  await main()
  const drifted = reportShapeDrift(recorder.transcript, EXPECTED)
  console.log(`\nTranscript: ${writeTranscript('steadfast', recorder.transcript)}`)
  process.exit(drifted ? 1 : 0)
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`\n${error.message}\n`)
    process.exit(2)
  }

  console.error('\nFailed.')
  if (BdCommerceError.is(error)) {
    const code = error.providerCode ? ` ${error.providerCode}` : ''
    console.error(`  steadfast ${error.code}${code}`)
    console.error(`  ${error.message}`)
  } else {
    console.error(error)
  }

  // A failed run is the interesting one; keep the transcript.
  reportShapeDrift(recorder.transcript, EXPECTED)
  console.error(`\nTranscript: ${writeTranscript('steadfast', recorder.transcript)}`)
  process.exit(1)
}
