import { generateKeyPairSync, constants, publicEncrypt, createSign } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { NagadClient } from '../src/nagad/client.js'
import { createNodeCrypto, dhakaTimestamp, randomChallenge } from '../src/nagad/crypto.js'
import { isPaid, toPaymentOutcome } from '../src/nagad/status.js'
import { ConfigError, ProviderError, ValidationError } from '../src/core/errors.js'
import { createFetchMock, type MockReply } from './helpers.js'

/**
 * A real RSA keypair, generated once. Using genuine keys means the encrypt,
 * decrypt, sign and verify paths are actually executed rather than stubbed —
 * the crypto is the part of this client most likely to be wrong.
 *
 * The test plays both sides: `merchant` is us, `nagad` stands in for Nagad.
 */
let merchant: { publicKey: string; privateKey: string }
let nagad: { publicKey: string; privateKey: string }

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKey, privateKey }
}

beforeAll(() => {
  merchant = keypair()
  nagad = keypair()
})

/** Builds the encrypted envelope Nagad would send back. */
function nagadReply(payload: unknown, algorithm: 'SHA256' | 'SHA1' = 'SHA256'): MockReply {
  const plaintext = JSON.stringify(payload)

  // Nagad encrypts to the merchant's public key and signs with its own private.
  const sensitiveData = publicEncrypt(
    { key: merchant.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, 'utf8'),
  ).toString('base64')

  const signer = createSign(algorithm)
  signer.update(plaintext)
  signer.end()

  return { body: { sensitiveData, signature: signer.sign(nagad.privateKey, 'base64') } }
}

const CONFIG = () => ({
  merchantId: '683002007104225',
  merchantNumber: '01700000000',
  callbackUrl: 'https://shop.example.com/api/nagad/callback',
  merchantPrivateKey: merchant.privateKey,
  // From the client's point of view, "Nagad's public key" verifies its replies.
  nagadPublicKey: nagad.publicKey,
  sandbox: true,
})

function makeClient(replies: MockReply[], overrides = {}) {
  const mock = createFetchMock(replies)
  const client = new NagadClient({
    ...CONFIG(),
    fetch: mock.fetchImpl,
    retries: 0,
    ...overrides,
  })
  return { client, mock }
}

const INITIALIZED = { paymentReferenceId: 'MDExNjMxN', challenge: 'NAGAD-CHALLENGE-1' }
const COMPLETED: MockReply = {
  body: { status: 'Success', callBackUrl: 'https://sandbox.mynagad.com/checkout/MDExNjMxN' },
}

describe('NagadClient construction', () => {
  it('requires the merchant identity', () => {
    for (const field of ['merchantId', 'merchantNumber', 'callbackUrl'] as const) {
      expect(() => new NagadClient({ ...CONFIG(), [field]: '' })).toThrow(ConfigError)
    }
  })

  it('requires keys or a crypto provider', () => {
    const { merchantPrivateKey: _p, nagadPublicKey: _n, ...rest } = CONFIG()
    expect(() => new NagadClient(rest)).toThrow(ConfigError)
  })

  it('accepts a bare base64 key, without PEM armor', () => {
    // What the merchant portal actually hands you.
    const bare = merchant.privateKey
      .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '')
    const bareNagad = nagad.publicKey
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '')

    expect(() =>
      createNodeCrypto({ merchantPrivateKey: bare, nagadPublicKey: bareNagad }),
    ).not.toThrow()
  })

  it('explains an unusable key rather than leaking a crypto error', () => {
    expect(() =>
      createNodeCrypto({ merchantPrivateKey: 'not-a-key', nagadPublicKey: nagad.publicKey }),
    ).toThrow(/merchant portal|PKCS#8/)
  })
})

describe('createPayment', () => {
  it('runs initialize then complete against the right paths', async () => {
    const { client, mock } = makeClient([nagadReply(INITIALIZED), COMPLETED])
    await client.createPayment({ orderId: 'ORD-1042', amount: 1250 })

    expect(mock.calls[0]?.url).toBe(
      'http://sandbox.mynagad.com/remote-payment-gateway/api/dfs/check-out/initialize/683002007104225/ORD-1042',
    )
    expect(mock.calls[1]?.url).toBe(
      'http://sandbox.mynagad.com/remote-payment-gateway/api/dfs/check-out/complete/MDExNjMxN',
    )
  })

  it('sends the X-KM headers Nagad requires', async () => {
    const { client, mock } = makeClient([nagadReply(INITIALIZED), COMPLETED])
    await client.createPayment({ orderId: 'ORD-1042', amount: 1250 })

    expect(mock.calls[0]?.headers['x-km-api-version']).toBe('v-0.2.0')
    expect(mock.calls[0]?.headers['x-km-client-type']).toBe('PC_WEB')
    expect(mock.calls[0]?.headers['x-km-ip-v4']).toBeTruthy()
  })

  it('substitutes a routable IP for loopback, which Nagad rejects', async () => {
    const { client, mock } = makeClient([nagadReply(INITIALIZED), COMPLETED], {
      clientIp: '127.0.0.1',
    })
    await client.createPayment({ orderId: 'ORD-1042', amount: 1250 })

    expect(mock.calls[0]?.headers['x-km-ip-v4']).not.toBe('127.0.0.1')
  })

  it('encrypts a payload Nagad could actually decrypt, with its own field casing', async () => {
    const { client, mock } = makeClient([nagadReply(INITIALIZED), COMPLETED])
    await client.createPayment({ orderId: 'ORD-1042', amount: 1250 })

    const body = mock.calls[0]?.body as { sensitiveData: string; dateTime: string }
    // Decrypt from Nagad's side using the merchant public key... which is not
    // how it works: Nagad decrypts with its own private key. Model that.
    const asNagad = createNodeCrypto({
      merchantPrivateKey: nagad.privateKey,
      nagadPublicKey: merchant.publicKey,
    })
    const sensitive = JSON.parse(asNagad.decrypt(body.sensitiveData))

    expect(sensitive).toMatchObject({ merchantId: '683002007104225', orderId: 'ORD-1042' })
    // Lowercase inside, camelCase outside. Nagad's spelling, not a typo.
    expect(sensitive.datetime).toMatch(/^\d{14}$/)
    expect(body.dateTime).toMatch(/^\d{14}$/)
    expect(sensitive.challenge).toBeTruthy()
  })

  it('echoes back the challenge Nagad returned, not the one it sent', async () => {
    const { client, mock } = makeClient([nagadReply(INITIALIZED), COMPLETED])
    await client.createPayment({ orderId: 'ORD-1042', amount: 1250 })

    const asNagad = createNodeCrypto({
      merchantPrivateKey: nagad.privateKey,
      nagadPublicKey: merchant.publicKey,
    })
    const completeBody = mock.calls[1]?.body as { sensitiveData: string }
    const sensitive = JSON.parse(asNagad.decrypt(completeBody.sensitiveData))

    expect(sensitive.challenge).toBe('NAGAD-CHALLENGE-1')
    expect(sensitive.currencyCode).toBe('050')
    expect(sensitive.amount).toBe('1250')
  })

  it('sends the callback URL in the complete body', async () => {
    const { client, mock } = makeClient([nagadReply(INITIALIZED), COMPLETED])
    await client.createPayment({ orderId: 'ORD-1042', amount: 1250 })

    expect(mock.calls[1]?.body).toMatchObject({
      paymentRefId: 'MDExNjMxN',
      merchantCallbackURL: 'https://shop.example.com/api/nagad/callback',
    })
  })

  it('returns the redirect URL', async () => {
    const { client } = makeClient([nagadReply(INITIALIZED), COMPLETED])

    await expect(
      client.createPayment({ orderId: 'ORD-1042', amount: 1250 }),
    ).resolves.toMatchObject({
      paymentReferenceId: 'MDExNjMxN',
      redirectUrl: 'https://sandbox.mynagad.com/checkout/MDExNjMxN',
      orderId: 'ORD-1042',
      amount: '1250',
    })
  })

  it('never replays either leg, so a timeout cannot double-charge', async () => {
    const { client, mock } = makeClient([{ status: 500 }], { retries: 3 })

    await expect(client.createPayment({ orderId: 'ORD-1042', amount: 1250 })).rejects.toThrow()
    expect(mock.callCount).toBe(1)
  })

  it.each([
    [{ orderId: '', amount: 1250 }, 'orderId'],
    [{ orderId: 'ORD-1', amount: 0 }, 'amount'],
    [{ orderId: 'ORD-1', amount: -5 }, 'amount'],
    [{ orderId: 'ORD-1', amount: 100, callbackUrl: 'not-a-url' }, 'callbackUrl'],
  ])('rejects bad input before any request (%#)', async (input, field) => {
    const { client, mock } = makeClient([nagadReply(INITIALIZED), COMPLETED])

    const error = await client.createPayment(input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).field).toBe(field)
    expect(mock.callCount).toBe(0)
  })

  it('reports a Nagad rejection instead of failing on a missing field', async () => {
    const { client } = makeClient([
      { body: { reason: 'Invalid Merchant', message: 'merchant not found' } },
    ])

    const error = await client
      .createPayment({ orderId: 'ORD-1042', amount: 1250 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as Error).message).toContain('merchant not found')
  })

  it('says the key pair is mismatched when decryption fails', async () => {
    const stranger = keypair()
    const badReply: MockReply = {
      body: {
        sensitiveData: publicEncrypt(
          { key: stranger.publicKey, padding: constants.RSA_PKCS1_PADDING },
          Buffer.from('{}', 'utf8'),
        ).toString('base64'),
        signature: '',
      },
    }
    const { client } = makeClient([badReply])

    const error = await client
      .createPayment({ orderId: 'ORD-1042', amount: 1250 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as Error).message).toContain('does not match the public key')
  })
})

describe("Node's RSA decryption does not fail loudly", () => {
  it('returns garbage rather than throwing on a mismatched key', () => {
    // The mitigations for the Marvin/Bleichenbacher attacks made implicit
    // rejection the norm: a wrong key yields random bytes, not an exception.
    // The client's "keys do not match" message depends on this, so if this
    // test ever fails, that error handling can be simplified.
    const stranger = keypair()
    const ciphertext = publicEncrypt(
      { key: stranger.publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from('{"a":1}', 'utf8'),
    ).toString('base64')

    const mine = createNodeCrypto({
      merchantPrivateKey: merchant.privateKey,
      nagadPublicKey: nagad.publicKey,
    })

    let threw = false
    let plaintext = ''
    try {
      plaintext = mine.decrypt(ciphertext)
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(() => JSON.parse(plaintext)).toThrow()
  })
})

describe('response signature', () => {
  it('names the algorithm to try when verification fails', async () => {
    // Nagad signs with SHA1; the client is configured for SHA256.
    const { client } = makeClient([nagadReply(INITIALIZED, 'SHA1'), COMPLETED])

    const error = await client
      .createPayment({ orderId: 'ORD-1042', amount: 1250 })
      .catch((e: unknown) => e)
    expect((error as Error).message).toContain("signatureAlgorithm: 'SHA1'")
  })

  it('accepts SHA1 when the client is told to expect it', async () => {
    const { client } = makeClient([nagadReply(INITIALIZED, 'SHA1'), COMPLETED], {
      signatureAlgorithm: 'SHA1',
    })

    await expect(
      client.createPayment({ orderId: 'ORD-1042', amount: 1250 }),
    ).resolves.toMatchObject({ paymentReferenceId: 'MDExNjMxN' })
  })

  it('can be switched off, but is on by default', async () => {
    const { client } = makeClient([nagadReply(INITIALIZED, 'SHA1'), COMPLETED], {
      verifyResponseSignature: false,
    })

    await expect(client.createPayment({ orderId: 'ORD-1042', amount: 1250 })).resolves.toBeTruthy()
  })
})

describe('verifyPayment', () => {
  it('normalizes the outcome', async () => {
    const { client, mock } = makeClient([
      {
        body: {
          merchantId: '683002007104225',
          orderId: 'ORD-1042',
          paymentRefId: 'MDExNjMxN',
          amount: '1250',
          clientMobileNo: '01712345678',
          issuerPaymentRefNo: 'TXN123456',
          issuerPaymentDateTime: '2026-09-10 12:00:00',
          status: 'Success',
          statusCode: '000',
        },
      },
    ])

    const verified = await client.verifyPayment('MDExNjMxN')
    expect(mock.calls[0]?.url).toContain('/api/dfs/verify/payment/MDExNjMxN')
    expect(verified).toMatchObject({
      orderId: 'ORD-1042',
      outcome: 'success',
      providerStatus: 'Success',
      issuerPaymentRefNo: 'TXN123456',
      amount: '1250',
    })
  })

  it('does not treat an aborted payment as paid', async () => {
    const { client } = makeClient([{ body: { orderId: 'ORD-1042', status: 'Aborted' } }])

    const verified = await client.verifyPayment('MDExNjMxN')
    expect(verified.outcome).toBe('cancelled')
    expect(isPaid(verified.providerStatus)).toBe(false)
  })

  it('requires a payment reference', async () => {
    const { client } = makeClient([{ body: {} }])
    await expect(client.verifyPayment('')).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('parseCallback', () => {
  it('reads a full redirect URL', () => {
    const callback = NagadClient.parseCallback(
      'https://shop.example.com/cb?merchant=683&order_id=ORD-1042&payment_ref_id=MDExNjMxN&status=Success&status_code=000',
    )

    expect(callback).toMatchObject({
      orderId: 'ORD-1042',
      paymentReferenceId: 'MDExNjMxN',
      outcome: 'success',
      providerStatus: 'Success',
      statusCode: '000',
    })
  })

  it('accepts a plain search-param object', () => {
    expect(
      NagadClient.parseCallback({ payment_ref_id: 'REF1', order_id: 'O1', status: 'Aborted' }),
    ).toMatchObject({ outcome: 'cancelled' })
  })

  it('rejects a callback with no payment reference', () => {
    expect(() => NagadClient.parseCallback('?status=Success')).toThrow(ValidationError)
  })

  it('reports an unrecognized status as unknown, never as paid', () => {
    const callback = NagadClient.parseCallback({ payment_ref_id: 'R', status: 'Something' })
    expect(callback.outcome).toBe('unknown')
    expect(isPaid(callback.providerStatus)).toBe(false)
  })
})

describe('outcome mapping', () => {
  it.each([
    ['Success', 'success'],
    ['Aborted', 'cancelled'],
    ['Cancelled', 'cancelled'],
    ['Failed', 'failed'],
    ['Initiated', 'pending'],
    ['Ready', 'pending'],
    ['whatever', 'unknown'],
  ])('maps %s to %s', (raw, expected) => {
    expect(toPaymentOutcome(raw)).toBe(expected)
  })

  it('only Success counts as paid', () => {
    expect(isPaid('Success')).toBe(true)
    for (const status of ['Aborted', 'Failed', 'Ready', 'unknown', '']) {
      expect(isPaid(status)).toBe(false)
    }
  })
})

describe('helpers', () => {
  it('formats the timestamp as Dhaka local time, not UTC', () => {
    // 2026-09-10T00:30:00Z is 06:30 the same day in Dhaka (UTC+6).
    expect(dhakaTimestamp(new Date('2026-09-10T00:30:00Z'))).toBe('20260910063000')
    // 2026-09-09T20:00:00Z has already rolled over to the 10th in Dhaka.
    expect(dhakaTimestamp(new Date('2026-09-09T20:00:00Z'))).toBe('20260910020000')
  })

  it('produces a 14-digit timestamp', () => {
    expect(dhakaTimestamp()).toMatch(/^\d{14}$/)
  })

  it('generates a distinct challenge each time', () => {
    const a = randomChallenge()
    const b = randomChallenge()
    expect(a).toMatch(/^[0-9A-F]{40}$/)
    expect(a).not.toBe(b)
  })
})
