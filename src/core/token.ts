/**
 * Shared OAuth-style token handling. Both bKash and Pathao hand out a
 * short-lived access token plus a refresh token, and both rate-limit the grant
 * endpoint, so both need exactly this.
 */

export interface AccessToken {
  accessToken: string
  /** Absent when the provider does not issue one. */
  refreshToken?: string
  /** Epoch ms after which the token must not be used. */
  expiresAt: number
}

/**
 * Where the access token lives between requests.
 *
 * The in-memory default is right for a single long-lived process and wrong for
 * serverless, where every cold start grants again against a rate-limited
 * endpoint. Back this with Redis or any shared cache in production.
 */
export interface TokenStore {
  get(): Promise<AccessToken | null>
  set(token: AccessToken): Promise<void>
  clear?(): Promise<void>
}

export class MemoryTokenStore implements TokenStore {
  private token: AccessToken | null = null

  async get(): Promise<AccessToken | null> {
    return this.token
  }

  async set(token: AccessToken): Promise<void> {
    this.token = token
  }

  async clear(): Promise<void> {
    this.token = null
  }
}

/** Renew this many ms before the real expiry, to survive clock drift. */
export const EXPIRY_SKEW_MS = 60_000

export interface TokenManagerOptions {
  store: TokenStore
  /** Full credential grant. Used on first call and when a refresh fails. */
  grant: () => Promise<AccessToken>
  /**
   * Cheaper renewal using the stored refresh token. Omit when the provider
   * has no refresh flow; every renewal then goes through `grant`.
   */
  refresh?: (refreshToken: string) => Promise<AccessToken>
}

/**
 * Keeps exactly one token acquisition in flight. Concurrent callers share a
 * single grant rather than each racing the provider for their own.
 */
export class TokenManager {
  private inFlight: Promise<AccessToken> | null = null

  constructor(private readonly options: TokenManagerOptions) {}

  async getToken(): Promise<string> {
    const cached = await this.options.store.get()
    if (cached && isFresh(cached)) return cached.accessToken

    this.inFlight ??= this.acquire(cached).finally(() => {
      this.inFlight = null
    })
    const token = await this.inFlight
    return token.accessToken
  }

  /** Drops the cached token so the next call grants a new one. */
  async invalidate(): Promise<void> {
    await this.options.store.clear?.()
  }

  private async acquire(cached: AccessToken | null): Promise<AccessToken> {
    let token: AccessToken

    if (cached?.refreshToken && this.options.refresh) {
      try {
        token = await this.options.refresh(cached.refreshToken)
      } catch {
        // A refresh token can be revoked or expired independently of the
        // access token; a full grant is the documented recovery, so the first
        // error is not worth surfacing.
        token = await this.options.grant()
      }
    } else {
      token = await this.options.grant()
    }

    await this.options.store.set(token)
    return token
  }
}

function isFresh(token: AccessToken): boolean {
  return Boolean(token.accessToken) && token.expiresAt - EXPIRY_SKEW_MS > Date.now()
}
