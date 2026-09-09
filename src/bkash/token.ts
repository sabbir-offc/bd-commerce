export interface BkashToken {
  idToken: string
  refreshToken: string
  /** Epoch ms after which the token must not be used. */
  expiresAt: number
}

/**
 * Where the id token lives between requests.
 *
 * bKash rate-limits token grants hard, and a serverless deployment that grants
 * a fresh token per invocation will start failing under load. Back this with
 * Redis or any shared cache in production; the in-memory default is only right
 * for a single long-lived process.
 */
export interface BkashTokenStore {
  get(): Promise<BkashToken | null>
  set(token: BkashToken): Promise<void>
  clear?(): Promise<void>
}

export class MemoryTokenStore implements BkashTokenStore {
  private token: BkashToken | null = null

  async get(): Promise<BkashToken | null> {
    return this.token
  }

  async set(token: BkashToken): Promise<void> {
    this.token = token
  }

  async clear(): Promise<void> {
    this.token = null
  }
}

/** Refresh this many ms before the real expiry, to survive clock drift. */
const EXPIRY_SKEW_MS = 60_000

export interface TokenManagerOptions {
  store: BkashTokenStore
  /** Full credential grant. Used on first call and when a refresh fails. */
  grant: () => Promise<BkashToken>
  /** Cheaper renewal using the stored refresh token. */
  refresh: (refreshToken: string) => Promise<BkashToken>
}

/**
 * Keeps exactly one token in flight. Concurrent callers share a single grant
 * rather than each racing bKash for their own.
 */
export class TokenManager {
  private inFlight: Promise<BkashToken> | null = null

  constructor(private readonly options: TokenManagerOptions) {}

  async getToken(): Promise<string> {
    const cached = await this.options.store.get()
    if (cached && isFresh(cached)) return cached.idToken

    this.inFlight ??= this.acquire(cached).finally(() => {
      this.inFlight = null
    })
    const token = await this.inFlight
    return token.idToken
  }

  /** Drops the cached token so the next call grants a new one. */
  async invalidate(): Promise<void> {
    await this.options.store.clear?.()
  }

  private async acquire(cached: BkashToken | null): Promise<BkashToken> {
    let token: BkashToken

    if (cached?.refreshToken) {
      try {
        token = await this.options.refresh(cached.refreshToken)
      } catch {
        // A refresh token can be revoked or expired independently; a full
        // grant is the documented recovery, so do not surface the first error.
        token = await this.options.grant()
      }
    } else {
      token = await this.options.grant()
    }

    await this.options.store.set(token)
    return token
  }
}

function isFresh(token: BkashToken): boolean {
  return Boolean(token.idToken) && token.expiresAt - EXPIRY_SKEW_MS > Date.now()
}

export { EXPIRY_SKEW_MS }
