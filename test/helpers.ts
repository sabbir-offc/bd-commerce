import type { FetchLike } from '../src/core/http.js'

export interface MockReply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Reject the fetch instead of answering, to simulate a transport failure. */
  error?: Error
  /** Hold the response open this long, so timeouts and aborts can be tested. */
  delayMs?: number
}

export interface MockCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/**
 * A fetch double that answers a queued script and records what it was asked.
 * The last reply repeats, so a retry test does not need one entry per attempt.
 */
export function createFetchMock(replies: MockReply[]) {
  const calls: MockCall[] = []
  let index = 0

  const fetchImpl: FetchLike = (url, init = {}) => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? {}
    index++

    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: normalizeHeaders(init.headers),
      body: typeof init.body === 'string' ? safeParse(init.body) : init.body,
    })

    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal | undefined

      const finish = () => {
        if (reply.error) {
          reject(reply.error)
          return
        }
        const status = reply.status ?? 200
        resolve(
          new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
            status,
            headers: { 'content-type': 'application/json', ...reply.headers },
          }),
        )
      }

      if (!reply.delayMs) {
        finish()
        return
      }

      const timer = setTimeout(finish, reply.delayMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        const abortError = new Error('The operation was aborted')
        abortError.name = 'AbortError'
        reject(abortError)
      })
    })
  }

  return {
    fetchImpl,
    calls,
    get callCount() {
      return calls.length
    },
  }
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value
    })
    return result
  }
  const entries = Array.isArray(headers) ? headers : Object.entries(headers)
  for (const [key, value] of entries) result[String(key).toLowerCase()] = String(value)
  return result
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
