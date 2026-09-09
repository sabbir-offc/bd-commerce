import { AuthError, HttpError, NetworkError, RateLimitError, TimeoutError } from './errors.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpClientOptions {
  baseUrl: string
  provider: string
  /** Sent on every request. Per-request headers win on conflict. */
  headers?: Record<string, string>
  /** Per-attempt timeout. Default 20000. */
  timeoutMs?: number
  /** Extra attempts after the first, for retryable failures. Default 2. */
  retries?: number
  /** Base for exponential backoff, in ms. Default 300. */
  retryBaseMs?: number
  /** Inject a fetch implementation. Defaults to global fetch. */
  fetch?: FetchLike
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  headers?: Record<string, string>
  /** Overrides the client-level retry count for this request. */
  retries?: number
  /**
   * Whether this request is safe to replay. Defaults to true for GET and
   * false otherwise: a retried create_order would double-ship a parcel.
   */
  retryable?: boolean
}

export interface HttpResponse<T> {
  data: T
  status: number
  headers: Headers
}

/**
 * Small fetch wrapper: timeouts, bounded retries with jittered backoff, and
 * consistent error mapping. No dependencies, so it also runs on edge runtimes.
 */
export class HttpClient {
  private readonly baseUrl: string
  private readonly provider: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly retryBaseMs: number
  private readonly fetchImpl: FetchLike

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.provider = options.provider
    this.headers = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.retries = options.retries ?? 2
    this.retryBaseMs = options.retryBaseMs ?? 300

    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new TypeError(
        'No fetch implementation found. Use Node 18.17+ or pass `fetch` in the client options.',
      )
    }
    this.fetchImpl = fetchImpl as FetchLike
  }

  async request<T>(options: RequestOptions): Promise<HttpResponse<T>> {
    const url = this.buildUrl(options.path, options.query)
    const replayable = options.retryable ?? options.method === 'GET'
    const maxAttempts = 1 + (replayable ? (options.retries ?? this.retries) : 0)

    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let responseError: HttpError | AuthError | RateLimitError | undefined

      try {
        const response = await this.attempt(url, options)
        const parsed = await parseBody(response)

        if (response.ok) {
          return { data: parsed as T, status: response.status, headers: response.headers }
        }
        responseError = this.toResponseError(response, parsed)
      } catch (error) {
        const mapped = this.toTransportError(error)
        if (attempt < maxAttempts && mapped.retryable) {
          lastError = mapped
          await sleep(this.backoff(attempt))
          continue
        }
        throw mapped
      }

      if (attempt < maxAttempts && responseError.retryable) {
        lastError = responseError
        const retryAfterMs =
          responseError instanceof RateLimitError ? responseError.retryAfterMs : undefined
        await sleep(this.backoff(attempt, retryAfterMs))
        continue
      }
      throw responseError
    }

    // Unreachable: every path above returns or throws. Kept for exhaustiveness.
    throw lastError
  }

  private async attempt(url: string, options: RequestOptions): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.headers,
      ...options.headers,
    }

    let body: string | undefined
    if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      headers['content-type'] ??= 'application/json'
    }

    try {
      return await this.fetchImpl(url, {
        method: options.method,
        headers,
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`
    if (!query) return url

    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value))
    }
    const qs = params.toString()
    return qs ? `${url}?${qs}` : url
  }

  private toResponseError(response: Response, parsed: unknown) {
    const message = extractMessage(parsed) ?? response.statusText ?? 'Request failed'
    const base = { provider: this.provider, status: response.status, response: parsed }

    if (response.status === 401 || response.status === 403) {
      return new AuthError(`${this.provider}: ${message}`, base)
    }
    if (response.status === 429) {
      return new RateLimitError(`${this.provider}: ${message}`, {
        ...base,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      })
    }
    return new HttpError(`${this.provider}: ${message}`, { ...base, status: response.status })
  }

  private toTransportError(error: unknown) {
    if (isAbortError(error)) {
      return new TimeoutError(this.timeoutMs, { provider: this.provider, cause: error })
    }
    const message = error instanceof Error ? error.message : String(error)
    return new NetworkError(`${this.provider}: ${message}`, {
      provider: this.provider,
      cause: error,
    })
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return retryAfterMs
    const exponential = this.retryBaseMs * 2 ** (attempt - 1)
    return exponential + Math.random() * this.retryBaseMs
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null

  const contentType = response.headers.get('content-type') ?? ''
  const looksJson = contentType.includes('json') || /^\s*[{[]/.test(text)
  if (!looksJson) return text

  try {
    return JSON.parse(text)
  } catch {
    // A provider that mislabels HTML as JSON should not crash the caller.
    return text
  }
}

function extractMessage(parsed: unknown): string | undefined {
  if (typeof parsed === 'string') return parsed.slice(0, 300)
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    for (const key of ['message', 'statusMessage', 'error', 'errorMessage']) {
      const value = record[key]
      if (typeof value === 'string' && value) return value
    }
  }
  return undefined
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined

  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())

  return undefined
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
