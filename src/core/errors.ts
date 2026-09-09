/**
 * Every error thrown by this package is a `BdCommerceError`. Narrow with the
 * subclasses when you care about the reason, or read `.code` when you don't.
 */
export type BdCommerceErrorCode =
  | 'config_error'
  | 'validation_error'
  | 'network_error'
  | 'timeout'
  | 'auth_error'
  | 'rate_limited'
  | 'provider_error'
  | 'http_error'

export interface BdCommerceErrorOptions {
  /** Short slug of the provider that produced the error, e.g. `steadfast`. */
  provider: string
  /** HTTP status, when the failure came from a response. */
  status?: number
  /** Provider's own error code, e.g. bKash `statusCode`. */
  providerCode?: string
  /** Parsed response body, kept verbatim for logging and bug reports. */
  response?: unknown
  cause?: unknown
}

export class BdCommerceError extends Error {
  readonly code: BdCommerceErrorCode
  readonly provider: string
  readonly status?: number
  readonly providerCode?: string
  readonly response?: unknown
  /** True when retrying the same request could plausibly succeed. */
  readonly retryable: boolean

  constructor(
    message: string,
    code: BdCommerceErrorCode,
    options: BdCommerceErrorOptions,
    retryable = false,
  ) {
    super(message, { cause: options.cause })
    this.name = new.target.name
    this.code = code
    this.provider = options.provider
    this.status = options.status
    this.providerCode = options.providerCode
    this.response = options.response
    this.retryable = retryable
  }

  static is(error: unknown): error is BdCommerceError {
    return error instanceof BdCommerceError
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      provider: this.provider,
      status: this.status,
      providerCode: this.providerCode,
      retryable: this.retryable,
    }
  }
}

/** A client was constructed with missing or nonsensical options. */
export class ConfigError extends BdCommerceError {
  constructor(message: string, provider: string) {
    super(message, 'config_error', { provider })
  }
}

/** Input failed a local check, so no request was sent. */
export class ValidationError extends BdCommerceError {
  /** Field path that failed, when a single field is at fault. */
  readonly field?: string

  constructor(message: string, provider: string, field?: string) {
    super(message, 'validation_error', { provider })
    this.field = field
  }
}

/** The request never produced a response (DNS, TLS, socket, offline). */
export class NetworkError extends BdCommerceError {
  constructor(message: string, options: BdCommerceErrorOptions) {
    super(message, 'network_error', options, true)
  }
}

/** The request exceeded `timeoutMs` and was aborted. */
export class TimeoutError extends BdCommerceError {
  readonly timeoutMs: number

  constructor(timeoutMs: number, options: BdCommerceErrorOptions) {
    super(`Request timed out after ${timeoutMs}ms`, 'timeout', options, true)
    this.timeoutMs = timeoutMs
  }
}

/** Credentials were rejected (HTTP 401/403, or a provider auth code). */
export class AuthError extends BdCommerceError {
  constructor(message: string, options: BdCommerceErrorOptions) {
    super(message, 'auth_error', options)
  }
}

export class RateLimitError extends BdCommerceError {
  /** Parsed from `Retry-After` when the provider sent one. */
  readonly retryAfterMs?: number

  constructor(message: string, options: BdCommerceErrorOptions & { retryAfterMs?: number }) {
    super(message, 'rate_limited', options, true)
    this.retryAfterMs = options.retryAfterMs
  }
}

/**
 * The transport succeeded but the provider reported a business failure —
 * a non-200 `status` from Steadfast, or a non-`0000` bKash `statusCode`.
 */
export class ProviderError extends BdCommerceError {
  constructor(message: string, options: BdCommerceErrorOptions) {
    super(message, 'provider_error', options)
  }
}

/** A non-2xx response that isn't auth or rate limiting. */
export class HttpError extends BdCommerceError {
  constructor(message: string, options: BdCommerceErrorOptions & { status: number }) {
    super(message, 'http_error', options, options.status >= 500 || options.status === 408)
  }
}
