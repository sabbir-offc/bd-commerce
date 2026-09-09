/**
 * Pathao sandbox smoke test.
 *
 * Pathao has a real sandbox, so unlike Steadfast this can run the whole flow
 * end to end with nothing at stake, and unlike bKash it needs no human in the
 * middle. One command covers auth, stores, the city/zone/area hierarchy, a
 * price quote, an order, and reading that order back:
 *
 *   pnpm run smoke:pathao
 *   pnpm run smoke:pathao -- --no-create   # read-only pass
 *
 * Credentials default to the sandbox values Pathao publishes in its own
 * developer documentation, so this works with no setup. Override any of them
 * through .env (PATHAO_CLIENT_ID, PATHAO_CLIENT_SECRET, PATHAO_USERNAME,
 * PATHAO_PASSWORD) to run against your own sandbox merchant.
 *
 * Every exchange is written to `.smoke/pathao-<timestamp>.json` with
 * credentials, tokens and recipient details masked.
 */
import { PathaoClient } from '../src/pathao/index.js'
import { BdCommerceError, HttpError } from '../src/core/errors.js'
import {
  argv,
  createRecorder,
  field,
  hasFlag,
  heading,
  reportShapeDrift,
  UsageError,
  writeTranscript,
  type KeySpec,
} from './lib/recorder.js'

/**
 * Pathao's published sandbox credentials. Not secrets — they appear verbatim
 * in its developer docs so anyone can try the API before onboarding. Env vars
 * win, so a real sandbox merchant needs no code change.
 */
const SANDBOX_DEFAULTS = {
  clientId: '7N1aMJQbWm',
  clientSecret: 'wRcaibZkUdSNz2EI9ZyuXLlNrnAv0TdPUPXMnD39',
  username: 'test@pathao.com',
  password: 'lovePathao',
}

/** Taken from `src/pathao/types.ts`. Keys are the envelope, not the payload. */
const ENVELOPE = ['message', 'type', 'code'] as const

const PAGE_OPTIONAL = [
  'total',
  'total_in_page',
  'current_page',
  'per_page',
  'last_page',
  'path',
  'from',
  'to',
  'first_page_url',
  'last_page_url',
  'next_page_url',
  'prev_page_url',
]

const EXPECTED: Record<string, KeySpec> = {
  'issue-token': {
    required: ['access_token', 'token_type', 'expires_in'],
    optional: ['refresh_token'],
  },
  'external/login': {
    required: ['access_token'],
    optional: ['refresh_token', 'token_type', 'expires_in'],
  },
  stores: {
    required: [...ENVELOPE],
    nested: {
      data: {
        required: ['data'],
        optional: PAGE_OPTIONAL,
        nested: {
          data: {
            required: ['store_id', 'store_name'],
            optional: [
              'store_address',
              'is_active',
              'city_id',
              'zone_id',
              'hub_id',
              'is_default_store',
              'is_default_return_store',
              'hash_id',
            ],
          },
        },
      },
    },
  },
  'city-list': {
    required: [...ENVELOPE],
    nested: {
      data: {
        required: ['data'],
        optional: PAGE_OPTIONAL,
        nested: { data: { required: ['city_id', 'city_name'] } },
      },
    },
  },
  'zone-list': {
    required: [...ENVELOPE],
    nested: {
      data: {
        required: ['data'],
        optional: PAGE_OPTIONAL,
        nested: { data: { required: ['zone_id', 'zone_name'] } },
      },
    },
  },
  'area-list': {
    required: [...ENVELOPE],
    nested: {
      data: {
        required: ['data'],
        optional: PAGE_OPTIONAL,
        nested: {
          data: {
            required: ['area_id', 'area_name'],
            optional: ['home_delivery_available', 'pickup_available'],
          },
        },
      },
    },
  },
  'price-plan': {
    required: [...ENVELOPE],
    nested: {
      data: {
        required: ['price', 'discount', 'final_price'],
        optional: [
          'discount_type',
          'promo_discount',
          'plan_id',
          'cod_enabled',
          'cod_percentage',
          'cod_discount',
          'additional_charge',
        ],
      },
    },
  },
  orders: {
    required: [...ENVELOPE],
    nested: {
      data: {
        required: ['consignment_id', 'merchant_order_id', 'order_status', 'delivery_fee'],
      },
    },
  },
  'order-info': {
    required: [...ENVELOPE],
    nested: {
      data: {
        required: ['consignment_id', 'order_status'],
        optional: ['merchant_order_id', 'order_status_slug', 'updated_at', 'invoice_id'],
      },
    },
  },
}

const recorder = createRecorder({
  endpointOf,
  secretKeys: [
    'client_id',
    'client_secret',
    'password',
    'username',
    'access_token',
    'refresh_token',
    'authorization',
    'recipient_name',
    'recipient_phone',
    'recipient_address',
    'recipient_secondary_phone',
    'contact_number',
  ],
})

async function main() {
  const args = argv()

  const client = new PathaoClient({
    clientId: process.env.PATHAO_CLIENT_ID ?? SANDBOX_DEFAULTS.clientId,
    clientSecret: process.env.PATHAO_CLIENT_SECRET ?? SANDBOX_DEFAULTS.clientSecret,
    username: process.env.PATHAO_USERNAME ?? SANDBOX_DEFAULTS.username,
    password: process.env.PATHAO_PASSWORD ?? SANDBOX_DEFAULTS.password,
    sandbox: true,
    fetch: recorder.fetchImpl,
  })

  const usingDefaults = !process.env.PATHAO_CLIENT_ID
  heading('Pathao sandbox')
  field('credentials', usingDefaults ? "Pathao's published sandbox defaults" : 'from .env')

  const storeId = await pickStore(client)
  const where = await walkHierarchy(client)
  await quote(client, storeId, where)

  if (hasFlag(args, '--no-create')) {
    heading('Not run')
    console.log('  createOrder skipped by --no-create.')
    return
  }

  try {
    await createAndRead(client, storeId, where)
  } catch (error) {
    // Pathao's published sandbox merchant is shared by everyone trying the API,
    // and it periodically goes into arrears. That is an account state, not a
    // defect here: the request was accepted and refused for a business reason.
    if (!(error instanceof HttpError) || error.status !== 402) throw error

    heading('Create blocked')
    console.log(`  ${error.message}`)
    console.log('')
    console.log('  The shared sandbox merchant has an unpaid balance, so it cannot create')
    console.log('  orders right now. Everything up to this point is verified. To cover the')
    console.log('  create path, put your own sandbox credentials in .env and re-run.')
  }
}

async function pickStore(client: PathaoClient): Promise<number> {
  heading('Stores')

  recorder.step('listStores')
  const stores = await client.listStores()

  if (stores.length === 0) {
    throw new UsageError(
      'This sandbox merchant has no store. Create one in the Pathao merchant panel, or pass different credentials in .env.',
    )
  }
  const store = stores[0]!
  field('store', `${store.store_name} (${store.store_id})`)
  field('available', String(stores.length))
  return store.store_id
}

async function walkHierarchy(client: PathaoClient) {
  heading('City / zone / area')

  recorder.step('listCities')
  const cities = await client.listCities()
  const city = cities.find((c) => /dhaka/i.test(c.city_name)) ?? cities[0]
  if (!city) throw new UsageError('Pathao returned no cities')
  field('city', `${city.city_name} (${city.city_id})`)

  recorder.step('listZones')
  const zones = await client.listZones(city.city_id)
  const zone = zones[0]
  if (!zone) throw new UsageError(`Pathao returned no zones for ${city.city_name}`)
  field('zone', `${zone.zone_name} (${zone.zone_id})`)

  recorder.step('listAreas')
  const areas = await client.listAreas(zone.zone_id)
  const area = areas[0]
  field('area', area ? `${area.area_name} (${area.area_id})` : '(none returned)')

  // The name-based path is what most callers will actually use, and it is the
  // part most likely to break if Pathao renames something.
  recorder.step('resolveLocation (cached)')
  const resolved = await client.resolveLocation({ city: city.city_name, zone: zone.zone_name })
  field('resolved', `${resolved.cityId} / ${resolved.zoneId}`)

  return { cityId: city.city_id, zoneId: zone.zone_id, areaId: area?.area_id }
}

async function quote(
  client: PathaoClient,
  storeId: number,
  where: { cityId: number; zoneId: number },
) {
  heading('Price plan')

  recorder.step('calculatePrice')
  const price = await client.calculatePrice({
    storeId,
    recipientCity: where.cityId,
    recipientZone: where.zoneId,
    itemWeight: 0.5,
  })

  field('price', String(price.price))
  field('discount', String(price.discount))
  field('final', String(price.final_price))
}

async function createAndRead(
  client: PathaoClient,
  storeId: number,
  where: { cityId: number; zoneId: number; areaId?: number },
) {
  heading('Create an order (sandbox)')

  recorder.step('createOrder')
  const order = await client.createOrder({
    storeId,
    invoice: `SMOKE-${Date.now()}`,
    recipientName: 'Smoke Test',
    recipientPhone: '01712345678',
    recipientAddress: 'House 4, Road 11, Banani, Dhaka 1213',
    recipientCity: where.cityId,
    recipientZone: where.zoneId,
    ...(where.areaId ? { recipientArea: where.areaId } : {}),
    codAmount: 0,
    itemWeight: 0.5,
    note: 'bd-commerce smoke test',
  })

  field('consignment', order.consignmentId)
  field('status', `${order.status} (${order.providerStatus})`)
  field('fee', String(order.deliveryFee ?? '(not returned)'))

  // The pairing that matters: order info has to agree with what create said.
  recorder.step('getStatusByConsignmentId')
  const status = await client.getStatusByConsignmentId(order.consignmentId)
  field('re-read', `${status.status} (${status.providerStatus})`)
}

/** Collapses a Pathao URL to a stable spec key, dropping embedded ids. */
function endpointOf(url: string): string {
  const marker = '/aladdin/api/v1/'
  const index = url.indexOf(marker)
  if (index === -1) return url

  const path = url.slice(index + marker.length).split('?')[0] ?? ''
  const segments = path.split('/')
  const last = segments[segments.length - 1] ?? path

  if (last === 'city-list' || last === 'zone-list' || last === 'area-list') return last
  if (path === 'merchant/price-plan') return 'price-plan'
  if (path === 'external/login' || path === 'issue-token' || path === 'stores') return path
  if (segments[0] === 'orders') return segments.length > 1 ? 'order-info' : 'orders'
  return path
}

try {
  await main()
  const drifted = reportShapeDrift(recorder.transcript, EXPECTED)
  console.log(`\nTranscript: ${writeTranscript('pathao', recorder.transcript)}`)
  process.exit(drifted ? 1 : 0)
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`\n${error.message}\n`)
    process.exit(2)
  }

  console.error('\nFailed.')
  if (BdCommerceError.is(error)) {
    const code = error.providerCode ? ` ${error.providerCode}` : ''
    console.error(`  pathao ${error.code}${code}`)
    console.error(`  ${error.message}`)
  } else {
    console.error(error)
  }

  reportShapeDrift(recorder.transcript, EXPECTED)
  console.error(`\nTranscript: ${writeTranscript('pathao', recorder.transcript)}`)
  process.exit(1)
}
