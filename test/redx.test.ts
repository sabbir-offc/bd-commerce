import { describe, expect, it } from 'vitest'
import { RedxClient } from '../src/redx/client.js'
import { needsAttention, toDeliveryStatus } from '../src/redx/status.js'
import { ConfigError, ProviderError, ValidationError } from '../src/core/errors.js'
import { createFetchMock, type MockReply } from './helpers.js'

const CREDENTIALS = { accessToken: 'test-token' }

const CREATE_REPLY: MockReply = { body: { tracking_id: '21J9L5PP3AB4' } }

const AREAS_REPLY: MockReply = {
  body: {
    areas: [
      { id: 1, name: 'Banani', post_code: 1213, division_name: 'Dhaka' },
      { id: 2, name: 'Banani DOHS', post_code: 1206, division_name: 'Dhaka' },
    ],
  },
}

function makeClient(replies: MockReply[], overrides = {}) {
  const mock = createFetchMock(replies)
  const client = new RedxClient({
    ...CREDENTIALS,
    sandbox: true,
    defaultPickupStoreId: 777,
    fetch: mock.fetchImpl,
    retries: 0,
    ...overrides,
  })
  return { client, mock }
}

const ORDER = {
  invoice: 'ORD-1042',
  recipientName: 'Rahim Uddin',
  recipientPhone: '+8801712345678',
  recipientAddress: 'House 4, Road 11, Banani, Dhaka',
  deliveryAreaId: 1,
  deliveryArea: 'Banani',
  codAmount: 1250,
  parcelWeightGrams: 500,
}

describe('RedxClient construction', () => {
  it('requires an access token', () => {
    expect(() => new RedxClient({ accessToken: '' })).toThrow(ConfigError)
  })

  it('sends RedX its own header, not Authorization', async () => {
    const { client, mock } = makeClient([CREATE_REPLY])
    await client.createOrder(ORDER)

    expect(mock.calls[0]?.headers['api-access-token']).toBe('Bearer test-token')
    expect(mock.calls[0]?.headers.authorization).toBeUndefined()
  })

  it('uses the live host by default', async () => {
    const mock = createFetchMock([CREATE_REPLY])
    const client = new RedxClient({
      ...CREDENTIALS,
      defaultPickupStoreId: 1,
      fetch: mock.fetchImpl,
    })

    await client.createOrder(ORDER)
    expect(mock.calls[0]?.url).toContain('https://openapi.redx.com.bd/v1.0.0-beta/parcel')
  })
})

describe('createOrder', () => {
  it('maps to RedX field names', async () => {
    const { client, mock } = makeClient([CREATE_REPLY])
    await client.createOrder({ ...ORDER, note: 'Call first' })

    expect(mock.calls[0]?.url).toBe('https://sandbox.redx.com.bd/v1.0.0-beta/parcel')
    expect(mock.calls[0]?.body).toEqual({
      customer_name: 'Rahim Uddin',
      customer_phone: '01712345678',
      customer_address: 'House 4, Road 11, Banani, Dhaka',
      delivery_area: 'Banani',
      delivery_area_id: 1,
      merchant_invoice_id: 'ORD-1042',
      cash_collection_amount: 1250,
      parcel_weight: 500,
      value: 1250,
      pickup_store_id: 777,
      instruction: 'Call first',
    })
  })

  it('serializes parcel items into parcel_details_json', async () => {
    const { client, mock } = makeClient([CREATE_REPLY])
    await client.createOrder({
      ...ORDER,
      items: [{ name: 'T-shirt', category: 'Clothing', value: 800, quantity: 2 }],
    })

    const body = mock.calls[0]?.body as { parcel_details_json: string }
    expect(JSON.parse(body.parcel_details_json)).toEqual([
      { name: 'T-shirt', category: 'Clothing', value: 800, quantity: 2 },
    ])
  })

  it('defaults the declared value to the COD amount', async () => {
    const { client, mock } = makeClient([CREATE_REPLY])
    await client.createOrder(ORDER)

    expect((mock.calls[0]?.body as { value: number }).value).toBe(1250)
  })

  it('normalizes the response', async () => {
    const { client } = makeClient([CREATE_REPLY])

    await expect(client.createOrder(ORDER)).resolves.toMatchObject({
      provider: 'redx',
      consignmentId: '21J9L5PP3AB4',
      trackingCode: '21J9L5PP3AB4',
      invoice: 'ORD-1042',
      status: 'pending',
      codAmount: 1250,
    })
  })

  it('never replays a create, so a 500 cannot double-ship', async () => {
    const { client, mock } = makeClient([{ status: 500 }], { retries: 3 })

    await expect(client.createOrder(ORDER)).rejects.toThrow()
    expect(mock.callCount).toBe(1)
  })

  it('fails loudly when no tracking id comes back', async () => {
    const { client } = makeClient([{ body: {} }])
    await expect(client.createOrder(ORDER)).rejects.toBeInstanceOf(ProviderError)
  })

  it.each([
    [{ ...ORDER, invoice: '' }, 'invoice'],
    [{ ...ORDER, recipientName: '' }, 'recipientName'],
    [{ ...ORDER, recipientAddress: '' }, 'recipientAddress'],
    [{ ...ORDER, deliveryArea: '' }, 'deliveryArea'],
    [{ ...ORDER, deliveryAreaId: 0 }, 'deliveryAreaId'],
    [{ ...ORDER, codAmount: -1 }, 'codAmount'],
    [{ ...ORDER, recipientPhone: '0121234567' }, 'phone'],
  ])('rejects bad input before spending a request (%#)', async (input, field) => {
    const { client, mock } = makeClient([CREATE_REPLY])

    const error = await client.createOrder(input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).field).toBe(field)
    expect(mock.callCount).toBe(0)
  })

  it('demands a pickup store rather than guessing one', async () => {
    const mock = createFetchMock([CREATE_REPLY])
    const client = new RedxClient({ ...CREDENTIALS, sandbox: true, fetch: mock.fetchImpl })

    const error = await client.createOrder(ORDER).catch((e: unknown) => e)
    expect((error as ValidationError).field).toBe('pickupStoreId')
    expect(mock.callCount).toBe(0)
  })
})

describe('weight is in grams', () => {
  it('rejects a kilogram value that would ship a half-gram parcel', async () => {
    const { client, mock } = makeClient([CREATE_REPLY])

    // The exact mistake someone porting a Pathao integration would make.
    const error = await client
      .createOrder({ ...ORDER, parcelWeightGrams: 0.5 })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('grams, not kilograms')
    expect(mock.callCount).toBe(0)
  })

  it.each([0, -1, 30_001])('rejects %s grams', async (grams) => {
    const { client } = makeClient([CREATE_REPLY])
    await expect(client.createOrder({ ...ORDER, parcelWeightGrams: grams })).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('accepts a whole number of grams', async () => {
    const { client, mock } = makeClient([CREATE_REPLY])
    await client.createOrder({ ...ORDER, parcelWeightGrams: 1500 })

    expect((mock.calls[0]?.body as { parcel_weight: number }).parcel_weight).toBe(1500)
  })
})

describe('status lookups', () => {
  const INFO: MockReply = {
    body: {
      parcel: {
        tracking_id: '21J9L5PP3AB4',
        status: 'delivery-in-progress',
        merchant_invoice_id: 'ORD-1042',
      },
    },
  }

  it('reads a parcel by tracking code', async () => {
    const { client, mock } = makeClient([INFO])
    const status = await client.getStatusByTrackingCode('21J9L5PP3AB4')

    expect(mock.calls[0]?.url).toBe(
      'https://sandbox.redx.com.bd/v1.0.0-beta/parcel/info/21J9L5PP3AB4',
    )
    expect(status).toMatchObject({
      provider: 'redx',
      status: 'in_transit',
      providerStatus: 'delivery-in-progress',
      pendingApproval: false,
    })
  })

  it('treats the consignment id as the tracking id', async () => {
    const { client, mock } = makeClient([INFO])
    await client.getStatusByConsignmentId('21J9L5PP3AB4')

    expect(mock.calls[0]?.url).toContain('/parcel/info/21J9L5PP3AB4')
  })

  it('requires a tracking code', async () => {
    const { client } = makeClient([INFO])
    await expect(client.getStatusByTrackingCode('')).rejects.toBeInstanceOf(ValidationError)
  })

  it('returns the tracking timeline', async () => {
    const { client } = makeClient([
      { body: { tracking: [{ message_en: 'Parcel picked up', time: '2026-09-09T10:00:00Z' }] } },
    ])

    await expect(client.track('21J9L5PP3AB4')).resolves.toHaveLength(1)
  })
})

describe('areas', () => {
  it('caches the area list', async () => {
    const { client, mock } = makeClient([AREAS_REPLY])
    await client.listAreas()
    await client.listAreas()

    expect(mock.callCount).toBe(1)
  })

  it('resolves a name to an area', async () => {
    const { client } = makeClient([AREAS_REPLY])
    await expect(client.resolveArea('banani')).resolves.toMatchObject({ id: 1, name: 'Banani' })
  })

  it('prefers an exact match over a longer name containing it', async () => {
    const { client } = makeClient([AREAS_REPLY])
    await expect(client.resolveArea('Banani')).resolves.toMatchObject({ id: 1 })
  })

  it('refuses to guess and lists candidates', async () => {
    const { client } = makeClient([AREAS_REPLY])

    const error = await client.resolveArea('Bananee').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('Banani')
  })
})

describe('bulk create', () => {
  it('validates every row before creating any parcel', async () => {
    const { client, mock } = makeClient([CREATE_REPLY])

    // Row two is invalid; row one must not ship.
    await expect(
      client.createOrders([ORDER, { ...ORDER, invoice: 'A-2', parcelWeightGrams: 0.5 }]),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(mock.callCount).toBe(0)
  })

  it('reports per-row outcomes when a later row fails at the API', async () => {
    const { client } = makeClient([
      CREATE_REPLY,
      { status: 422, body: { message: 'duplicate merchant_invoice_id' } },
    ])

    const results = await client.createOrders([
      { ...ORDER, invoice: 'A-1' },
      { ...ORDER, invoice: 'A-2' },
    ])

    expect(results[0]).toMatchObject({ ok: true, invoice: 'A-1' })
    expect(results[1]).toMatchObject({ ok: false, invoice: 'A-2' })
  })

  it('rejects an empty batch', async () => {
    const { client } = makeClient([CREATE_REPLY])
    await expect(client.createOrders([])).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('pickup stores', () => {
  it('lists them', async () => {
    const { client, mock } = makeClient([
      { body: { pickup_stores: [{ id: 777, name: 'Main Store' }] } },
    ])

    await expect(client.listPickupStores()).resolves.toHaveLength(1)
    expect(mock.calls[0]?.url).toContain('/v1.0.0-beta/pickup/stores')
  })

  it('reads one by id', async () => {
    const { client, mock } = makeClient([{ body: { pickup_store: { id: 777, name: 'Main' } } }])

    await expect(client.getPickupStore(777)).resolves.toMatchObject({ id: 777 })
    expect(mock.calls[0]?.url).toContain('/v1.0.0-beta/pickup/store/info/777')
  })
})

describe('status mapping', () => {
  it.each([
    ['pickup-pending', 'pending'],
    ['pickup-completed', 'in_transit'],
    ['received-at-hub', 'in_transit'],
    ['in-transit', 'in_transit'],
    ['delivery-in-progress', 'in_transit'],
    ['delivered', 'delivered'],
    ['partial-delivered', 'partial_delivered'],
    ['return-in-progress', 'returned'],
    ['returned', 'returned'],
    ['cancelled', 'cancelled'],
    ['hold', 'on_hold'],
    ['something-new', 'unknown'],
  ])('maps %s to %s', (raw, expected) => {
    expect(toDeliveryStatus(raw)).toBe(expected)
  })

  it('normalizes separators and case', () => {
    // RedX hyphenates, but its vocabulary is not perfectly consistent.
    expect(toDeliveryStatus('In_Transit')).toBe('in_transit')
    expect(toDeliveryStatus('Delivery In Progress')).toBe('in_transit')
  })

  it('does not hide a failed attempt inside in_transit', () => {
    expect(toDeliveryStatus('delivery-failed')).toBe('on_hold')
    expect(needsAttention('delivery-failed')).toBe(true)
    expect(needsAttention('in-transit')).toBe(false)
  })
})
