import { describe, expect, it } from 'vitest'
import { PathaoClient } from '../src/pathao/client.js'
import { needsAttention, toDeliveryStatus } from '../src/pathao/status.js'
import { ConfigError, ProviderError, ValidationError } from '../src/core/errors.js'
import { createFetchMock, type MockReply } from './helpers.js'

const CREDENTIALS = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  username: 'merchant@example.com',
  password: 'secret',
}

const TOKEN_REPLY: MockReply = {
  body: {
    token_type: 'Bearer',
    expires_in: 432000,
    access_token: 'access-token-1',
    refresh_token: 'refresh-token-1',
  },
}

const CREATE_REPLY: MockReply = {
  status: 201,
  body: {
    message: 'Order Created Successfully',
    type: 'success',
    code: 200,
    data: {
      consignment_id: 'DH210827A9QWE',
      merchant_order_id: 'ORD-1042',
      order_status: 'Pending',
      delivery_fee: 60,
    },
  },
}

function envelope(data: unknown, status = 200): MockReply {
  return { status, body: { message: 'ok', type: 'success', code: 200, data } }
}

function makeClient(replies: MockReply[], overrides = {}) {
  const mock = createFetchMock(replies)
  const client = new PathaoClient({
    ...CREDENTIALS,
    sandbox: true,
    defaultStoreId: 12345,
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
  recipientCity: 1,
  recipientZone: 298,
  codAmount: 1250,
  itemWeight: 0.5,
}

describe('PathaoClient construction', () => {
  it('requires client credentials', () => {
    expect(() => new PathaoClient({ clientId: '', clientSecret: 's' })).toThrow(ConfigError)
    expect(() => new PathaoClient({ clientId: 'c', clientSecret: '' })).toThrow(ConfigError)
  })

  it('refuses a half-supplied password grant', () => {
    expect(() => new PathaoClient({ clientId: 'c', clientSecret: 's', username: 'u' })).toThrow(
      ConfigError,
    )
    expect(() => new PathaoClient({ clientId: 'c', clientSecret: 's', password: 'p' })).toThrow(
      ConfigError,
    )
  })
})

describe('authentication', () => {
  it('uses the password grant when username and password are given', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    await client.createOrder(ORDER)

    expect(mock.calls[0]?.url).toBe(
      'https://courier-api-sandbox.pathao.com/aladdin/api/v1/issue-token',
    )
    expect(mock.calls[0]?.body).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      username: 'merchant@example.com',
      password: 'secret',
      grant_type: 'password',
    })
    expect(mock.calls[1]?.headers.authorization).toBe('Bearer access-token-1')
  })

  it('falls back to client-credentials login when they are not', async () => {
    const mock = createFetchMock([TOKEN_REPLY, CREATE_REPLY])
    const client = new PathaoClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      sandbox: true,
      defaultStoreId: 1,
      fetch: mock.fetchImpl,
    })

    await client.createOrder(ORDER)
    expect(mock.calls[0]?.url).toContain('/aladdin/api/v1/external/login')
    expect(mock.calls[0]?.body).toEqual({ client_id: 'client-id', client_secret: 'client-secret' })
  })

  it('reuses a cached token and grants only once under concurrency', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    await Promise.all([client.createOrder(ORDER), client.createOrder(ORDER)])

    expect(mock.calls.filter((call) => call.url.endsWith('/issue-token'))).toHaveLength(1)
  })

  it('re-grants once when a cached token is rejected', async () => {
    const { client, mock } = makeClient([
      TOKEN_REPLY,
      { status: 401, body: { message: 'Unauthenticated.' } },
      TOKEN_REPLY,
      CREATE_REPLY,
    ])

    await expect(client.createOrder(ORDER)).resolves.toMatchObject({
      consignmentId: 'DH210827A9QWE',
    })
    expect(mock.calls.filter((call) => call.url.endsWith('/issue-token'))).toHaveLength(2)
  })

  it('uses the live host by default', async () => {
    const mock = createFetchMock([TOKEN_REPLY, CREATE_REPLY])
    const client = new PathaoClient({ ...CREDENTIALS, defaultStoreId: 1, fetch: mock.fetchImpl })

    await client.createOrder(ORDER)
    expect(mock.calls[0]?.url).toContain('https://api-hermes.pathao.com/')
  })
})

describe('createOrder', () => {
  it('maps to Pathao field names with defaults filled in', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    await client.createOrder({ ...ORDER, note: 'Call first', recipientArea: 1001 })

    expect(mock.calls[1]?.url).toBe('https://courier-api-sandbox.pathao.com/aladdin/api/v1/orders')
    expect(mock.calls[1]?.body).toEqual({
      store_id: 12345,
      merchant_order_id: 'ORD-1042',
      recipient_name: 'Rahim Uddin',
      recipient_phone: '01712345678',
      recipient_address: 'House 4, Road 11, Banani, Dhaka',
      recipient_city: 1,
      recipient_zone: 298,
      recipient_area: 1001,
      delivery_type: 48,
      item_type: 2,
      item_quantity: 1,
      item_weight: 0.5,
      amount_to_collect: 1250,
      special_instruction: 'Call first',
    })
  })

  it('normalizes the response and reports the delivery fee', async () => {
    const { client } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    const order = await client.createOrder(ORDER)

    expect(order).toMatchObject({
      provider: 'pathao',
      consignmentId: 'DH210827A9QWE',
      // Pathao has no separate tracking code.
      trackingCode: 'DH210827A9QWE',
      invoice: 'ORD-1042',
      status: 'pending',
      providerStatus: 'Pending',
      codAmount: 1250,
      deliveryFee: 60,
    })
  })

  it('never replays a create, so a 500 cannot double-ship', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, { status: 500 }], { retries: 3 })

    await expect(client.createOrder(ORDER)).rejects.toThrow()
    expect(mock.calls.filter((call) => call.url.endsWith('/orders'))).toHaveLength(1)
  })

  it.each([
    [{ ...ORDER, invoice: '' }, 'invoice'],
    [{ ...ORDER, recipientName: 'Ra' }, 'recipientName'],
    [{ ...ORDER, recipientAddress: 'Banani' }, 'recipientAddress'],
    [{ ...ORDER, recipientCity: 0 }, 'recipientCity'],
    [{ ...ORDER, recipientZone: 1.5 }, 'recipientZone'],
    [{ ...ORDER, codAmount: -1 }, 'codAmount'],
    [{ ...ORDER, itemWeight: 0.1 }, 'itemWeight'],
    [{ ...ORDER, itemWeight: 25 }, 'itemWeight'],
    [{ ...ORDER, itemQuantity: 0 }, 'itemQuantity'],
    [{ ...ORDER, recipientPhone: '0121234567' }, 'phone'],
  ])('rejects bad input before spending a request (%#)', async (input, field) => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])

    const error = await client.createOrder(input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).field).toBe(field)
    expect(mock.callCount).toBe(0)
  })

  it('demands a store rather than guessing one', async () => {
    const mock = createFetchMock([TOKEN_REPLY, CREATE_REPLY])
    const client = new PathaoClient({ ...CREDENTIALS, sandbox: true, fetch: mock.fetchImpl })

    const error = await client.createOrder(ORDER).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).field).toBe('storeId')
    expect(mock.callCount).toBe(0)
  })

  it('lets an order override the default store', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    await client.createOrder({ ...ORDER, storeId: 999 })

    expect((mock.calls[1]?.body as { store_id: number }).store_id).toBe(999)
  })

  it('flattens Pathao field errors into the message', async () => {
    const { client } = makeClient([
      TOKEN_REPLY,
      {
        status: 422,
        body: {
          message: 'The given data was invalid.',
          type: 'error',
          code: 422,
          errors: {
            recipient_address: ['The recipient address must be at least 10 characters.'],
            item_weight: ['The item weight field is required.'],
          },
        },
      },
    ])

    const error = await client.createOrder(ORDER).catch((e: unknown) => e)
    expect((error as Error).message).toContain('recipient_address: The recipient address')
    expect((error as Error).message).toContain('item_weight:')
  })
})

describe('getStatusByConsignmentId', () => {
  it('normalizes the order status', async () => {
    const { client, mock } = makeClient([
      TOKEN_REPLY,
      envelope({
        consignment_id: 'DH210827A9QWE',
        merchant_order_id: 'ORD-1042',
        order_status: 'In_Transit',
        order_status_slug: 'in_transit',
      }),
    ])

    const status = await client.getStatusByConsignmentId('DH210827A9QWE')
    expect(mock.calls[1]?.url).toContain('/aladdin/api/v1/orders/DH210827A9QWE')
    expect(status).toMatchObject({
      provider: 'pathao',
      status: 'in_transit',
      providerStatus: 'In_Transit',
      pendingApproval: false,
    })
  })

  it('requires an id', async () => {
    const { client } = makeClient([TOKEN_REPLY])
    await expect(client.getStatusByConsignmentId('')).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('location lookups', () => {
  const CITIES = envelope({ data: [{ city_id: 1, city_name: 'Dhaka' }] })
  const ZONES = envelope({
    data: [
      { zone_id: 298, zone_name: 'Banani' },
      { zone_id: 299, zone_name: 'Banani DOHS' },
    ],
  })
  const AREAS = envelope({ data: [{ area_id: 1001, area_name: 'Banani Road 11' }] })

  it('reads the city list from the countries/1 path', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CITIES])
    await client.listCities()

    expect(mock.calls[1]?.url).toBe(
      'https://courier-api-sandbox.pathao.com/aladdin/api/v1/countries/1/city-list',
    )
  })

  it('caches each level so repeated lookups cost nothing', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CITIES])
    await client.listCities()
    await client.listCities()

    expect(mock.calls.filter((call) => call.url.includes('city-list'))).toHaveLength(1)
  })

  it('resolves names to ids', async () => {
    const { client } = makeClient([TOKEN_REPLY, CITIES, ZONES, AREAS])

    await expect(
      client.resolveLocation({ city: 'dhaka', zone: 'Banani', area: 'Banani Road 11' }),
    ).resolves.toMatchObject({ cityId: 1, zoneId: 298, areaId: 1001 })
  })

  it('prefers an exact match over a longer name that contains it', async () => {
    const { client } = makeClient([TOKEN_REPLY, CITIES, ZONES])

    // "Banani" is a substring of "Banani DOHS"; the exact match must win
    // rather than the lookup being called ambiguous.
    await expect(client.resolveLocation({ city: 'Dhaka', zone: 'Banani' })).resolves.toMatchObject({
      zoneId: 298,
    })
  })

  it('refuses to guess an unknown name and lists candidates', async () => {
    const { client } = makeClient([TOKEN_REPLY, CITIES, ZONES])

    const error = await client
      .resolveLocation({ city: 'Dhaka', zone: 'Bananee' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('was not found')
    expect((error as Error).message).toContain('Banani')
  })
})

describe('calculatePrice', () => {
  it('quotes without creating anything', async () => {
    const { client, mock } = makeClient([
      TOKEN_REPLY,
      envelope({ price: 60, discount: 0, final_price: 60, cod_enabled: 1, cod_percentage: 1 }),
    ])

    await expect(
      client.calculatePrice({ recipientCity: 1, recipientZone: 298, itemWeight: 0.5 }),
    ).resolves.toMatchObject({ final_price: 60 })
    expect(mock.calls[1]?.url).toContain('/aladdin/api/v1/merchant/price-plan')
  })
})

describe('bulk create', () => {
  it('reports per-row outcomes', async () => {
    const { client } = makeClient([
      TOKEN_REPLY,
      envelope([
        {
          consignment_id: 'DH1',
          merchant_order_id: 'A-1',
          order_status: 'Pending',
          delivery_fee: 60,
        },
        { merchant_order_id: 'A-2', message: 'duplicate merchant_order_id' },
      ]),
    ])

    const results = await client.createOrders([
      { ...ORDER, invoice: 'A-1' },
      { ...ORDER, invoice: 'A-2' },
    ])

    expect(results[0]).toMatchObject({ ok: true, invoice: 'A-1' })
    expect(results[1]).toMatchObject({ ok: false, invoice: 'A-2' })
  })

  it('rejects an empty batch locally', async () => {
    const { client } = makeClient([TOKEN_REPLY])
    await expect(client.createOrders([])).rejects.toBeInstanceOf(ValidationError)
  })

  it('surfaces an unrecognized bulk response instead of silently dropping rows', async () => {
    const { client } = makeClient([TOKEN_REPLY, envelope({ unexpected: true })])

    await expect(client.createOrders([ORDER])).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('status mapping', () => {
  it.each([
    ['Pending', 'pending'],
    ['Pickup_Requested', 'pending'],
    ['Assigned_for_Pickup', 'pending'],
    ['Picked', 'in_transit'],
    ['At_the_Sorting_HUB', 'in_transit'],
    ['In_Transit', 'in_transit'],
    ['Assigned_for_Delivery', 'in_transit'],
    ['Delivered', 'delivered'],
    ['Payment_Invoice', 'delivered'],
    ['Partial_Delivery', 'partial_delivered'],
    ['Return', 'returned'],
    ['Cancelled', 'cancelled'],
    ['Pickup_Cancelled', 'cancelled'],
    ['On_Hold', 'on_hold'],
    ['something_new', 'unknown'],
  ])('maps %s to %s', (raw, expected) => {
    expect(toDeliveryStatus(raw)).toBe(expected)
  })

  it('matches the slug form as well as the titlecase form', () => {
    expect(toDeliveryStatus('in_transit')).toBe(toDeliveryStatus('In_Transit'))
  })

  it('does not hide a failed attempt inside in_transit', () => {
    // A merchant filtering for "moving" parcels would never see these again.
    expect(toDeliveryStatus('Pickup_Failed')).toBe('on_hold')
    expect(toDeliveryStatus('Delivery_Failed')).toBe('on_hold')
    expect(needsAttention('Delivery_Failed')).toBe(true)
    expect(needsAttention('In_Transit')).toBe(false)
  })
})
