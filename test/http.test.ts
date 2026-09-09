import { describe, expect, it } from 'vitest'
import { HttpClient } from '../src/core/http.js'
import {
  AuthError,
  HttpError,
  NetworkError,
  RateLimitError,
  TimeoutError,
} from '../src/core/errors.js'
import { createFetchMock } from './helpers.js'

function client(fetchImpl: ReturnType<typeof createFetchMock>['fetchImpl'], overrides = {}) {
  return new HttpClient({
    baseUrl: 'https://api.example.com/v1/',
    provider: 'test',
    retryBaseMs: 1,
    fetch: fetchImpl,
    ...overrides,
  })
}

describe('HttpClient', () => {
  it('joins base url and path without doubling slashes', async () => {
    const mock = createFetchMock([{ body: { ok: true } }])
    await client(mock.fetchImpl).request({ method: 'GET', path: '/things' })

    expect(mock.calls[0]?.url).toBe('https://api.example.com/v1/things')
  })

  it('serializes query params and drops undefined ones', async () => {
    const mock = createFetchMock([{ body: {} }])
    await client(mock.fetchImpl).request({
      method: 'GET',
      path: 'things',
      query: { page: 2, cursor: undefined, active: true },
    })

    expect(mock.calls[0]?.url).toBe('https://api.example.com/v1/things?page=2&active=true')
  })

  it('retries retryable statuses and returns the eventual success', async () => {
    const mock = createFetchMock([{ status: 503 }, { status: 503 }, { body: { ok: true } }])
    const response = await client(mock.fetchImpl).request<{ ok: boolean }>({
      method: 'GET',
      path: 'things',
    })

    expect(response.data).toEqual({ ok: true })
    expect(mock.callCount).toBe(3)
  })

  it('does not retry non-GET by default, because a replay can duplicate work', async () => {
    const mock = createFetchMock([{ status: 503, body: { message: 'busy' } }])

    await expect(
      client(mock.fetchImpl).request({ method: 'POST', path: 'orders', body: {} }),
    ).rejects.toBeInstanceOf(HttpError)
    expect(mock.callCount).toBe(1)
  })

  it('retries a POST when it is explicitly marked replayable', async () => {
    const mock = createFetchMock([{ status: 500 }, { body: { ok: true } }])
    await client(mock.fetchImpl).request({
      method: 'POST',
      path: 'orders',
      body: {},
      retryable: true,
    })

    expect(mock.callCount).toBe(2)
  })

  it('stops retrying once attempts are exhausted', async () => {
    const mock = createFetchMock([{ status: 500 }])

    await expect(
      client(mock.fetchImpl, { retries: 2 }).request({ method: 'GET', path: 'things' }),
    ).rejects.toBeInstanceOf(HttpError)
    expect(mock.callCount).toBe(3)
  })

  it('never retries a 4xx that is not rate limiting', async () => {
    const mock = createFetchMock([{ status: 422, body: { message: 'bad invoice' } }])

    await expect(
      client(mock.fetchImpl).request({ method: 'GET', path: 'things' }),
    ).rejects.toMatchObject({ code: 'http_error', status: 422, retryable: false })
    expect(mock.callCount).toBe(1)
  })

  it('maps 401 to AuthError', async () => {
    const mock = createFetchMock([{ status: 401, body: { message: 'Unauthorized' } }])

    await expect(
      client(mock.fetchImpl).request({ method: 'GET', path: 'things' }),
    ).rejects.toBeInstanceOf(AuthError)
  })

  it('maps 429 to RateLimitError and reads Retry-After', async () => {
    const mock = createFetchMock([
      { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '2' } },
    ])

    const error = await client(mock.fetchImpl, { retries: 0 })
      .request({ method: 'GET', path: 'things' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(RateLimitError)
    expect((error as RateLimitError).retryAfterMs).toBe(2000)
  })

  it('maps a transport failure to NetworkError', async () => {
    const mock = createFetchMock([{ error: new TypeError('fetch failed') }])

    await expect(
      client(mock.fetchImpl, { retries: 0 }).request({ method: 'GET', path: 'things' }),
    ).rejects.toBeInstanceOf(NetworkError)
  })

  it('aborts and reports a TimeoutError past timeoutMs', async () => {
    const mock = createFetchMock([{ delayMs: 500, body: {} }])

    await expect(
      client(mock.fetchImpl, { timeoutMs: 20, retries: 0 }).request({
        method: 'GET',
        path: 'things',
      }),
    ).rejects.toBeInstanceOf(TimeoutError)
  })

  it('surfaces a non-JSON error body as the message instead of crashing', async () => {
    const mock = createFetchMock([
      { status: 502, body: undefined, headers: { 'content-type': 'text/html' } },
    ])

    await expect(
      client(mock.fetchImpl, { retries: 0 }).request({ method: 'GET', path: 'things' }),
    ).rejects.toBeInstanceOf(HttpError)
  })

  it('recovers a JSON body that has a raw newline inside a string value', async () => {
    // Exactly what the bKash sandbox returns for bad credentials: HTTP 200
    // carrying JSON that is not legal JSON. Without the repair the status code
    // is unreachable and the failure gets misattributed.
    const malformed = `{"statusCode":"9999","statusMessage":"Invalid credentials.\n"}`
    const fetchImpl = async () =>
      new Response(malformed, { headers: { 'content-type': 'application/json' } })

    const response = await client(fetchImpl).request<{ statusCode: string }>({
      method: 'GET',
      path: 'things',
    })

    expect(response.data.statusCode).toBe('9999')
  })

  it('falls back to the raw text when a body cannot be repaired', async () => {
    const fetchImpl = async () =>
      new Response('<html>gateway error</html>', {
        headers: { 'content-type': 'application/json' },
      })

    const response = await client(fetchImpl).request({ method: 'GET', path: 'things' })
    expect(response.data).toBe('<html>gateway error</html>')
  })

  it('sends configured headers on every request', async () => {
    const mock = createFetchMock([{ body: {} }])
    await client(mock.fetchImpl, { headers: { 'Api-Key': 'k' } }).request({
      method: 'POST',
      path: 'things',
      body: { a: 1 },
    })

    expect(mock.calls[0]?.headers['api-key']).toBe('k')
    expect(mock.calls[0]?.headers['content-type']).toBe('application/json')
    expect(mock.calls[0]?.body).toEqual({ a: 1 })
  })
})
