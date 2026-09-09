import { describe, expect, it } from 'vitest'
import { BkashClient } from '../src/bkash/client.js'
import { MemoryTokenStore } from '../src/bkash/token.js'
import { ConfigError, ProviderError, ValidationError } from '../src/core/errors.js'
import { createFetchMock, type MockReply } from './helpers.js'

const CREDENTIALS = {
  appKey: 'app-key',
  appSecret: 'app-secret',
  username: 'merchant',
  password: 'secret',
}

const TOKEN_REPLY: MockReply = {
  body: {
    statusCode: '0000',
    statusMessage: 'Successful',
    id_token: 'id-token-1',
    refresh_token: 'refresh-token-1',
    token_type: 'Bearer',
    expires_in: 3600,
  },
}

const CREATE_REPLY: MockReply = {
  body: {
    statusCode: '0000',
    statusMessage: 'Successful',
    paymentID: 'TR0011abc',
    bkashURL: 'https://sandbox.payment.bkash.com/redirect/TR0011abc',
    callbackURL: 'https://shop.example.com/callback',
    amount: '1250',
    intent: 'sale',
    currency: 'BDT',
    paymentCreateTime: '2026-09-09T10:00:00:000 GMT+0600',
    transactionStatus: 'Initiated',
    merchantInvoiceNumber: 'ORD-1042',
  },
}

function makeClient(replies: MockReply[]) {
  const mock = createFetchMock(replies)
  const client = new BkashClient({
    ...CREDENTIALS,
    sandbox: true,
    fetch: mock.fetchImpl,
    retries: 0,
    tokenStore: new MemoryTokenStore(),
  })
  return { client, mock }
}

const PAYMENT = {
  amount: 1250,
  invoiceNumber: 'ORD-1042',
  callbackURL: 'https://shop.example.com/callback',
}

describe('BkashClient construction', () => {
  it('requires all four credentials', () => {
    for (const field of ['appKey', 'appSecret', 'username', 'password'] as const) {
      expect(() => new BkashClient({ ...CREDENTIALS, [field]: '' })).toThrow(ConfigError)
    }
  })
})

describe('createPayment', () => {
  it('grants a token first, then creates against the sandbox host', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    await client.createPayment(PAYMENT)

    expect(mock.calls[0]?.url).toBe(
      'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/token/grant',
    )
    expect(mock.calls[0]?.headers.username).toBe('merchant')
    expect(mock.calls[0]?.body).toEqual({ app_key: 'app-key', app_secret: 'app-secret' })

    expect(mock.calls[1]?.url).toBe(
      'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/create',
    )
    expect(mock.calls[1]?.headers.authorization).toBe('id-token-1')
    expect(mock.calls[1]?.headers['x-app-key']).toBe('app-key')
  })

  it('defaults mode, currency, intent and payerReference', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    await client.createPayment(PAYMENT)

    expect(mock.calls[1]?.body).toEqual({
      mode: '0011',
      payerReference: 'ORD-1042',
      callbackURL: 'https://shop.example.com/callback',
      amount: '1250',
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: 'ORD-1042',
    })
  })

  it('returns the redirect URL and payment id', async () => {
    const { client } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    const payment = await client.createPayment(PAYMENT)

    expect(payment).toMatchObject({
      paymentId: 'TR0011abc',
      bkashUrl: 'https://sandbox.payment.bkash.com/redirect/TR0011abc',
      invoiceNumber: 'ORD-1042',
      amount: '1250',
    })
  })

  it('reuses a cached token across calls', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY, CREATE_REPLY])
    await client.createPayment(PAYMENT)
    await client.createPayment(PAYMENT)

    const grants = mock.calls.filter((call) => call.url.endsWith('/token/grant'))
    expect(grants).toHaveLength(1)
    expect(mock.callCount).toBe(3)
  })

  it('grants only once when concurrent calls race', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    await Promise.all([client.createPayment(PAYMENT), client.createPayment(PAYMENT)])

    expect(mock.calls.filter((call) => call.url.endsWith('/token/grant'))).toHaveLength(1)
  })

  it('treats a non-0000 statusCode as an error despite HTTP 200', async () => {
    const { client } = makeClient([
      TOKEN_REPLY,
      { status: 200, body: { statusCode: '2062', statusMessage: 'Insufficient Balance' } },
    ])

    const error = await client.createPayment(PAYMENT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).providerCode).toBe('2062')
  })

  it.each([
    [{ ...PAYMENT, amount: 0 }, 'amount'],
    [{ ...PAYMENT, amount: 0.5 }, 'amount'],
    [{ ...PAYMENT, invoiceNumber: '' }, 'invoiceNumber'],
    [{ ...PAYMENT, callbackURL: 'not-a-url' }, 'callbackURL'],
    [{ ...PAYMENT, callbackURL: 'ftp://shop.example.com/cb' }, 'callbackURL'],
  ])('rejects bad input before any request (%#)', async (input, field) => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])

    const error = await client.createPayment(input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).field).toBe(field)
    expect(mock.callCount).toBe(0)
  })

  it('formats fractional amounts to two decimals', async () => {
    const { client, mock } = makeClient([TOKEN_REPLY, CREATE_REPLY])
    await client.createPayment({ ...PAYMENT, amount: 1250.5 })

    expect((mock.calls[1]?.body as { amount: string }).amount).toBe('1250.50')
  })
})

describe('executePayment', () => {
  it('normalizes the executed payment', async () => {
    const { client } = makeClient([
      TOKEN_REPLY,
      {
        body: {
          statusCode: '0000',
          paymentID: 'TR0011abc',
          trxID: 'AH7011XYZ',
          transactionStatus: 'Completed',
          amount: '1250',
          currency: 'BDT',
          intent: 'sale',
          paymentExecuteTime: '2026-09-09T10:02:00:000 GMT+0600',
          merchantInvoiceNumber: 'ORD-1042',
          customerMsisdn: '01712345678',
        },
      },
    ])

    await expect(client.executePayment('TR0011abc')).resolves.toMatchObject({
      paymentId: 'TR0011abc',
      trxId: 'AH7011XYZ',
      transactionStatus: 'Completed',
      invoiceNumber: 'ORD-1042',
      customerMsisdn: '01712345678',
    })
  })

  it('re-grants and retries once when the cached token was rejected', async () => {
    const mock = createFetchMock([
      TOKEN_REPLY,
      { status: 401, body: { statusMessage: 'Invalid token' } },
      TOKEN_REPLY,
      { body: { statusCode: '0000', paymentID: 'TR0011abc', trxID: 'AH7011XYZ' } },
    ])
    const client = new BkashClient({
      ...CREDENTIALS,
      sandbox: true,
      fetch: mock.fetchImpl,
      retries: 0,
    })

    await expect(client.executePayment('TR0011abc')).resolves.toMatchObject({
      trxId: 'AH7011XYZ',
    })
    expect(mock.calls.filter((call) => call.url.endsWith('/token/grant'))).toHaveLength(2)
  })

  it('requires a payment id', async () => {
    const { client } = makeClient([TOKEN_REPLY])
    await expect(client.executePayment('')).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('unparseable responses', () => {
  it('reports the payload instead of blaming a missing field', async () => {
    const mock = createFetchMock([{ body: 'not json at all' }])
    const client = new BkashClient({
      ...CREDENTIALS,
      sandbox: true,
      fetch: mock.fetchImpl,
      retries: 0,
    })

    const error = await client.executePayment('TR1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).message).toContain('unparseable response')
  })
})

describe('parseCallback', () => {
  it('reads a full redirect URL', () => {
    expect(
      BkashClient.parseCallback(
        'https://shop.example.com/callback?paymentID=TR0011abc&status=success',
      ),
    ).toMatchObject({ paymentId: 'TR0011abc', status: 'success' })
  })

  it('accepts URLSearchParams and plain search-param objects', () => {
    expect(
      BkashClient.parseCallback(new URLSearchParams({ paymentID: 'TR1', status: 'cancel' })),
    ).toMatchObject({ paymentId: 'TR1', status: 'cancel' })

    expect(BkashClient.parseCallback({ paymentID: 'TR2', status: 'failure' })).toMatchObject({
      paymentId: 'TR2',
      status: 'failure',
    })
  })

  it('falls back to failure for an unrecognized status', () => {
    expect(BkashClient.parseCallback({ paymentID: 'TR3', status: 'weird' }).status).toBe('failure')
  })

  it('rejects a callback with no paymentID', () => {
    expect(() => BkashClient.parseCallback('?status=success')).toThrow(ValidationError)
  })
})

describe('refund', () => {
  it('requires every field bKash needs', async () => {
    const { client } = makeClient([TOKEN_REPLY])
    await expect(
      client.refund({ paymentId: 'TR1', trxId: '', amount: 100, sku: 'SKU', reason: 'damaged' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
