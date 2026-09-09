import { describe, expect, it } from 'vitest'
import { SteadfastClient } from '../src/steadfast/client.js'
import { reportedStatus, toDeliveryStatus } from '../src/steadfast/status.js'
import { AuthError, ConfigError, ProviderError, ValidationError } from '../src/core/errors.js'
import { createFetchMock, type MockReply } from './helpers.js'

const CREDENTIALS = { apiKey: 'test-key', secretKey: 'test-secret' }

const CONSIGNMENT = {
  consignment_id: 1424107,
  invoice: 'ORD-1042',
  tracking_code: '15BAEB8A',
  recipient_name: 'Rahim Uddin',
  recipient_phone: '01712345678',
  recipient_address: 'House 4, Road 11, Banani, Dhaka',
  cod_amount: 1250,
  status: 'in_review',
  note: 'Handle with care',
  created_at: '2026-09-09T10:00:00.000000Z',
}

function makeClient(replies: MockReply[]) {
  const mock = createFetchMock(replies)
  const client = new SteadfastClient({ ...CREDENTIALS, fetch: mock.fetchImpl, retries: 0 })
  return { client, mock }
}

const VALID_ORDER = {
  invoice: 'ORD-1042',
  recipientName: 'Rahim Uddin',
  recipientPhone: '+8801712345678',
  recipientAddress: 'House 4, Road 11, Banani, Dhaka',
  codAmount: 1250,
  note: 'Handle with care',
}

describe('SteadfastClient construction', () => {
  it('requires both credentials', () => {
    expect(() => new SteadfastClient({ apiKey: '', secretKey: 's' })).toThrow(ConfigError)
    expect(() => new SteadfastClient({ apiKey: 'k', secretKey: '' })).toThrow(ConfigError)
  })
})

describe('createOrder', () => {
  it('sends snake_case fields with a normalized phone and auth headers', async () => {
    const { client, mock } = makeClient([
      { body: { status: 200, message: 'ok', consignment: CONSIGNMENT } },
    ])
    await client.createOrder(VALID_ORDER)

    const call = mock.calls[0]!
    expect(call.url).toBe('https://portal.packzy.com/api/v1/create_order')
    expect(call.method).toBe('POST')
    expect(call.headers['api-key']).toBe('test-key')
    expect(call.headers['secret-key']).toBe('test-secret')
    expect(call.body).toEqual({
      invoice: 'ORD-1042',
      recipient_name: 'Rahim Uddin',
      recipient_phone: '01712345678',
      recipient_address: 'House 4, Road 11, Banani, Dhaka',
      cod_amount: 1250,
      note: 'Handle with care',
    })
  })

  it('normalizes the response and keeps the raw payload', async () => {
    const { client } = makeClient([{ body: { status: 200, consignment: CONSIGNMENT } }])
    const order = await client.createOrder(VALID_ORDER)

    expect(order).toMatchObject({
      provider: 'steadfast',
      consignmentId: '1424107',
      trackingCode: '15BAEB8A',
      invoice: 'ORD-1042',
      status: 'in_review',
      providerStatus: 'in_review',
      codAmount: 1250,
    })
    expect(order.raw).toEqual(CONSIGNMENT)
  })

  it('treats an in-body non-200 status as a failure even though HTTP said 200', async () => {
    const { client } = makeClient([
      { status: 200, body: { status: 400, message: 'Invoice already used' } },
    ])

    await expect(client.createOrder(VALID_ORDER)).rejects.toBeInstanceOf(ProviderError)
  })

  it('never replays a create, so a 500 does not risk a duplicate parcel', async () => {
    const { client, mock } = makeClient([{ status: 500 }])

    await expect(client.createOrder(VALID_ORDER)).rejects.toThrow()
    expect(mock.callCount).toBe(1)
  })

  it.each([
    [{ ...VALID_ORDER, invoice: '' }, 'invoice'],
    [{ ...VALID_ORDER, recipientName: '' }, 'recipientName'],
    [{ ...VALID_ORDER, recipientAddress: '' }, 'recipientAddress'],
    [{ ...VALID_ORDER, codAmount: -5 }, 'codAmount'],
    [{ ...VALID_ORDER, recipientPhone: '0121234567' }, 'phone'],
    [{ ...VALID_ORDER, recipientName: 'x'.repeat(101) }, 'recipientName'],
  ])('rejects bad input before spending a request (%#)', async (input, field) => {
    const { client, mock } = makeClient([{ body: { status: 200, consignment: CONSIGNMENT } }])

    const error = await client.createOrder(input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).field).toBe(field)
    expect(mock.callCount).toBe(0)
  })

  it('can skip phone normalization when the caller already handles it', async () => {
    const mock = createFetchMock([{ body: { status: 200, consignment: CONSIGNMENT } }])
    const client = new SteadfastClient({
      ...CREDENTIALS,
      fetch: mock.fetchImpl,
      validatePhone: false,
    })

    await client.createOrder({ ...VALID_ORDER, recipientPhone: '0121234567' })
    expect((mock.calls[0]?.body as { recipient_phone: string }).recipient_phone).toBe('0121234567')
  })
})

describe('createOrders', () => {
  it('wraps rows under `data` and reports per-row outcomes', async () => {
    const { client, mock } = makeClient([
      {
        body: [
          { invoice: 'A-1', consignment_id: 1, tracking_code: 'T1', status: 'success' },
          { invoice: 'A-2', status: 'error: duplicate invoice' },
        ],
      },
    ])

    const results = await client.createOrders([
      { ...VALID_ORDER, invoice: 'A-1' },
      { ...VALID_ORDER, invoice: 'A-2' },
    ])

    expect((mock.calls[0]?.body as { data: unknown[] }).data).toHaveLength(2)
    expect(results[0]).toMatchObject({ ok: true, invoice: 'A-1' })
    expect(results[1]).toMatchObject({ ok: false, invoice: 'A-2' })
  })

  it('rejects an empty or oversized batch locally', async () => {
    const { client } = makeClient([{ body: [] }])

    await expect(client.createOrders([])).rejects.toBeInstanceOf(ValidationError)
    await expect(
      client.createOrders(Array.from({ length: 501 }, () => VALID_ORDER)),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('status lookups', () => {
  it('reads status by consignment id', async () => {
    const { client, mock } = makeClient([{ body: { status: 200, delivery_status: 'delivered' } }])
    const status = await client.getStatusByConsignmentId(1424107)

    expect(mock.calls[0]?.url).toBe('https://portal.packzy.com/api/v1/status_by_cid/1424107')
    expect(status).toMatchObject({
      status: 'delivered',
      providerStatus: 'delivered',
      pendingApproval: false,
    })
  })

  it('url-encodes an invoice that contains a slash', async () => {
    const { client, mock } = makeClient([{ body: { status: 200, delivery_status: 'pending' } }])
    await client.getStatusByInvoice('ORD/1042')

    expect(mock.calls[0]?.url).toBe('https://portal.packzy.com/api/v1/status_by_invoice/ORD%2F1042')
  })

  it('does not report an unsettled outcome as final', async () => {
    const { client } = makeClient([
      { body: { status: 200, delivery_status: 'delivered_approval_pending' } },
    ])
    const status = await client.getStatusByTrackingCode('15BAEB8A')

    expect(status.status).toBe('in_review')
    expect(status.pendingApproval).toBe(true)
    expect(status.providerStatus).toBe('delivered_approval_pending')
  })

  it('requires an identifier', async () => {
    const { client } = makeClient([{ body: {} }])
    await expect(client.getStatusByInvoice('')).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('credential failures', () => {
  // Payload recorded from the live API on 2026-09-09. Steadfast counts down
  // and locks the key, so a merchant must see the count before burning it.
  it('puts the remaining attempts in the error message', async () => {
    const { client } = makeClient([
      {
        status: 401,
        body: {
          status: 401,
          message: 'Unauthorized Access (invalid API credentials)',
          attempts_left: 9,
        },
      },
    ])

    const error = await client.getBalance().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthError)
    expect((error as AuthError).message).toContain('9 credential attempts left')
  })

  it('says the key is locked at zero', async () => {
    const { client } = makeClient([
      { status: 401, body: { status: 401, message: 'Unauthorized', attempts_left: 0 } },
    ])

    const error = await client.getBalance().catch((e: unknown) => e)
    expect((error as AuthError).message).toContain('this API key is locked')
  })

  it('does not retry an auth failure, so attempts are not burned three at a time', async () => {
    const mock = createFetchMock([
      { status: 401, body: { status: 401, message: 'Unauthorized', attempts_left: 5 } },
    ])
    const client = new SteadfastClient({ ...CREDENTIALS, fetch: mock.fetchImpl, retries: 2 })

    await expect(client.getBalance()).rejects.toBeInstanceOf(AuthError)
    expect(mock.callCount).toBe(1)
  })
})

describe('getBalance', () => {
  it('returns the merchant balance as a number', async () => {
    const { client } = makeClient([{ body: { status: 200, current_balance: 4230.5 } }])
    await expect(client.getBalance()).resolves.toMatchObject({ currentBalance: 4230.5 })
  })
})

describe('status mapping', () => {
  it.each([
    ['pending', 'pending'],
    ['delivered', 'delivered'],
    ['partial_delivered', 'partial_delivered'],
    ['cancelled', 'cancelled'],
    ['hold', 'on_hold'],
    ['in_review', 'in_review'],
    ['unknown', 'unknown'],
    ['delivered_approval_pending', 'in_review'],
    ['cancelled_approval_pending', 'in_review'],
    ['something_new', 'unknown'],
  ])('maps %s to %s', (raw, expected) => {
    expect(toDeliveryStatus(raw)).toBe(expected)
  })

  it('exposes the unsettled outcome separately', () => {
    expect(reportedStatus('delivered_approval_pending')).toBe('delivered')
    expect(reportedStatus('cancelled_approval_pending')).toBe('cancelled')
    expect(reportedStatus('delivered')).toBeUndefined()
  })
})
