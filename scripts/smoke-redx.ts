/**
 * RedX smoke test.
 *
 * RedX has a sandbox, but unlike Pathao it publishes no shared credentials —
 * you need a merchant token either way, so there is nothing to run without one.
 * Set REDX_ACCESS_TOKEN in .env and it defaults to the sandbox host:
 *
 *   pnpm run smoke:redx                     # areas + stores, no writes
 *   pnpm run smoke:redx -- --create         # plus a sandbox parcel
 *   pnpm run smoke:redx -- --live           # read-only against production
 *
 * Creating against production needs `--live --create --confirm-live`, because
 * that is a real parcel a rider can collect.
 *
 * Every exchange is written to `.smoke/redx-<timestamp>.json` with the token
 * and recipient details masked.
 */
import { RedxClient } from '../src/redx/index.js'
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

/** Taken from `src/redx/types.ts`. */
const EXPECTED: Record<string, KeySpec> = {
  areas: {
    required: ['areas'],
    nested: {
      areas: {
        required: ['id', 'name'],
        optional: ['post_code', 'division_name', 'zone_id', 'district_name'],
      },
    },
  },
  'pickup/stores': {
    required: ['pickup_stores'],
    nested: {
      pickup_stores: {
        required: ['id', 'name'],
        optional: ['address', 'phone', 'area_id', 'area_name', 'is_default_store'],
      },
    },
  },
  'pickup/store/info': {
    required: ['pickup_store'],
    nested: {
      pickup_store: {
        required: ['id', 'name'],
        optional: ['address', 'phone', 'area_id', 'area_name', 'is_default_store'],
      },
    },
  },
  parcel: { required: ['tracking_id'], optional: ['message'] },
  'parcel/info': {
    required: ['parcel'],
    nested: {
      parcel: {
        required: ['tracking_id', 'status'],
        optional: [
          'customer_name',
          'customer_phone',
          'customer_address',
          'merchant_invoice_id',
          'cash_collection_amount',
          'parcel_weight',
          'value',
          'instruction',
          'delivery_area',
          'delivery_area_id',
          'charge',
          'created_at',
          'updated_at',
        ],
      },
    },
  },
  'parcel/track': { required: ['tracking'] },
}

const recorder = createRecorder({
  endpointOf,
  secretKeys: ['api-access-token', 'customer_name', 'customer_phone', 'customer_address', 'phone'],
})

async function main() {
  const args = argv()
  const live = hasFlag(args, '--live')

  // Refuse an unsafe combination before anything touches the network.
  if (live && hasFlag(args, '--create') && !hasFlag(args, '--confirm-live')) {
    throw new UsageError(
      '--live --create makes a real parcel that a rider may collect.\n' +
        'Add --confirm-live once you are ready, and cancel it in the RedX panel after.',
    )
  }

  const client = new RedxClient({
    accessToken: requireEnv('REDX_ACCESS_TOKEN'),
    sandbox: !live,
    ...(process.env.REDX_STORE_ID
      ? { defaultPickupStoreId: Number(process.env.REDX_STORE_ID) }
      : {}),
    fetch: recorder.fetchImpl,
  })

  heading(`RedX ${live ? 'PRODUCTION' : 'sandbox'}`)

  const storeId = await pickStore(client)
  const area = await pickArea(client, args)

  if (!hasFlag(args, '--create')) {
    heading('Not run')
    console.log('  createOrder skipped. Pass --create to exercise it.')
    return
  }
  await createAndRead(client, storeId, area)
}

async function pickStore(client: RedxClient): Promise<number> {
  heading('Pickup stores')

  recorder.step('listPickupStores')
  const stores = await client.listPickupStores()

  if (stores.length === 0) {
    throw new UsageError(
      'This merchant has no pickup store. Create one in the RedX panel before creating parcels.',
    )
  }
  const store = stores.find((s) => s.is_default_store) ?? stores[0]!
  field('store', `${store.name} (${store.id})`)
  field('available', String(stores.length))

  recorder.step('getPickupStore')
  await client.getPickupStore(store.id)

  return Number(process.env.REDX_STORE_ID) || store.id
}

async function pickArea(client: RedxClient, args: string[]) {
  heading('Areas')

  recorder.step('listAreas')
  const areas = await client.listAreas()
  field('count', String(areas.length))

  const wanted = flagValue(args, '--area')
  // The name-based path is what callers actually use, and the part most likely
  // to break if RedX renames something.
  recorder.step('resolveArea (cached)')
  const area = wanted ? await client.resolveArea(wanted) : areas[0]
  if (!area) throw new UsageError('RedX returned no areas')

  field('area', `${area.name} (${area.id})`)
  return area
}

async function createAndRead(
  client: RedxClient,
  storeId: number,
  area: { id: number; name: string },
) {
  heading('Create a parcel')

  recorder.step('createOrder')
  const order = await client.createOrder({
    pickupStoreId: storeId,
    invoice: `SMOKE-${Date.now()}`,
    recipientName: 'Smoke Test',
    recipientPhone: '01712345678',
    recipientAddress: 'House 4, Road 11, Banani, Dhaka 1213',
    deliveryAreaId: area.id,
    deliveryArea: area.name,
    codAmount: 0,
    parcelWeightGrams: 500,
    note: 'bd-commerce smoke test — please cancel',
  })

  field('tracking', order.trackingCode)

  recorder.step('getStatusByTrackingCode')
  const status = await client.getStatusByTrackingCode(order.trackingCode)
  field('status', `${status.status} (${status.providerStatus})`)

  recorder.step('track')
  const events = await client.track(order.trackingCode)
  field('events', String(events.length))
}

/** `.../v1.0.0-beta/parcel/info/ABC123` becomes `parcel/info`. */
function endpointOf(url: string): string {
  const marker = `/v1.0.0-beta/`
  const index = url.indexOf(marker)
  if (index === -1) return url

  const path = (url.slice(index + marker.length).split('?')[0] ?? '').replace(/\/+$/, '')
  for (const known of ['parcel/info', 'parcel/track', 'pickup/store/info', 'pickup/stores']) {
    if (path === known || path.startsWith(`${known}/`)) return known
  }
  return path
}

try {
  await main()
  const drifted = reportShapeDrift(recorder.transcript, EXPECTED)
  console.log(`\nTranscript: ${writeTranscript('redx', recorder.transcript)}`)
  process.exit(drifted ? 1 : 0)
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`\n${error.message}\n`)
    process.exit(2)
  }

  console.error('\nFailed.')
  if (BdCommerceError.is(error)) {
    const code = error.providerCode ? ` ${error.providerCode}` : ''
    console.error(`  redx ${error.code}${code}`)
    console.error(`  ${error.message}`)
  } else {
    console.error(error)
  }

  reportShapeDrift(recorder.transcript, EXPECTED)
  console.error(`\nTranscript: ${writeTranscript('redx', recorder.transcript)}`)
  process.exit(1)
}
