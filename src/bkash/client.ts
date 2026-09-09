import { AuthError, ConfigError, ProviderError, ValidationError } from '../core/errors.js'
import { HttpClient, type FetchLike } from '../core/http.js'
import { MemoryTokenStore, TokenManager, type BkashToken, type BkashTokenStore } from './token.js'
import {
  BKASH_SUCCESS_CODE,
  type BkashCallbackStatus,
  type BkashCreatePaymentResponse,
  type BkashExecutePaymentResponse,
  type BkashGrantTokenResponse,
  type BkashPaymentMode,
  type BkashQueryPaymentResponse,
  type BkashRefundResponse,
  type BkashSearchTransactionResponse,
  type BkashStatusFields,
} from './types.js'

export const BKASH_SANDBOX_BASE_URL = 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'
export const BKASH_LIVE_BASE_URL = 'https://tokenized.pay.bka.sh/v1.2.0-beta'

const PROVIDER = 'bkash'
const CHECKOUT = 'tokenized/checkout'

export interface BkashConfig {
  appKey: string
  appSecret: string
  username: string
  password: string
  /** Selects the sandbox base URL. Default false (live). */
  sandbox?: boolean
  /** Overrides both sandbox and live base URLs. */
  baseUrl?: string
  timeoutMs?: number
  retries?: number
  fetch?: FetchLike
  /**
   * Where the id token is cached. Defaults to process memory, which is wrong
   * for serverless: give it Redis or another shared store there.
   */
  tokenStore?: BkashTokenStore
}

export interface CreatePaymentInput {
  /** BDT. bKash rejects amounts below 1. */
  amount: number | string
  /** Your order reference, surfaced to the customer and in settlement files. */
  invoiceNumber: string
  /** Absolute URL bKash redirects the shopper back to. */
  callbackURL: string
  /** Identifier for the payer, commonly their phone or your customer id. Defaults to `invoiceNumber`. */
  payerReference?: string
  /** Default `0011`: one-off checkout with no stored agreement. */
  mode?: BkashPaymentMode
  /** Default `BDT`. */
  currency?: string
  /** Default `sale`. */
  intent?: 'sale' | 'authorization'
  agreementID?: string
}

export interface BkashPayment {
  paymentId: string
  /** Send the shopper here to authorize the payment. */
  bkashUrl: string
  amount: string
  currency: string
  invoiceNumber: string
  transactionStatus: string
  createdAt: string
  raw: BkashCreatePaymentResponse
}

export interface BkashExecutedPayment {
  paymentId: string
  /** bKash transaction id. This is what a customer will quote in a dispute. */
  trxId: string
  amount: string
  currency: string
  invoiceNumber: string
  transactionStatus: string
  customerMsisdn?: string
  payerReference?: string
  executedAt: string
  raw: BkashExecutePaymentResponse
}

export interface RefundInput {
  paymentId: string
  /** From the executed payment. */
  trxId: string
  amount: number | string
  /** Your item/SKU reference. Required by bKash. */
  sku: string
  reason: string
}

export interface BkashCallback {
  paymentId: string
  status: BkashCallbackStatus
  raw: Record<string, string>
}

/**
 * Client for bKash tokenized checkout.
 *
 * ```ts
 * const bkash = new BkashClient({ ...credentials, sandbox: true })
 *
 * // 1. On checkout, create the payment and redirect.
 * const payment = await bkash.createPayment({
 *   amount: 1250,
 *   invoiceNumber: 'ORD-1042',
 *   callbackURL: 'https://shop.example.com/api/bkash/callback',
 * })
 * redirect(payment.bkashUrl)
 *
 * // 2. In the callback route, execute. Nothing is charged until you do.
 * const { paymentId, status } = BkashClient.parseCallback(request.url)
 * if (status === 'success') {
 *   const executed = await bkash.executePayment(paymentId)
 * }
 * ```
 */
export class BkashClient {
  readonly provider = PROVIDER

  private readonly http: HttpClient
  private readonly appKey: string
  private readonly tokens: TokenManager

  constructor(config: BkashConfig) {
    for (const field of ['appKey', 'appSecret', 'username', 'password'] as const) {
      if (!config?.[field]) throw new ConfigError(`\`${field}\` is required`, PROVIDER)
    }

    this.appKey = config.appKey
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: config.baseUrl ?? (config.sandbox ? BKASH_SANDBOX_BASE_URL : BKASH_LIVE_BASE_URL),
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      fetch: config.fetch,
    })

    this.tokens = new TokenManager({
      store: config.tokenStore ?? new MemoryTokenStore(),
      grant: () => this.grantToken(config),
      refresh: (refreshToken) => this.refreshToken(config, refreshToken),
    })
  }

  async createPayment(input: CreatePaymentInput): Promise<BkashPayment> {
    requireText(input?.invoiceNumber, 'invoiceNumber')
    const callbackURL = requireAbsoluteUrl(input.callbackURL, 'callbackURL')
    const amount = formatAmount(input.amount)

    const data = await this.authed<BkashCreatePaymentResponse>('create', {
      mode: input.mode ?? '0011',
      payerReference: input.payerReference ?? input.invoiceNumber,
      callbackURL,
      amount,
      currency: input.currency ?? 'BDT',
      intent: input.intent ?? 'sale',
      merchantInvoiceNumber: input.invoiceNumber,
      ...(input.agreementID ? { agreementID: input.agreementID } : {}),
    })

    return {
      paymentId: data.paymentID,
      bkashUrl: data.bkashURL,
      amount: data.amount,
      currency: data.currency,
      invoiceNumber: data.merchantInvoiceNumber,
      transactionStatus: data.transactionStatus,
      createdAt: data.paymentCreateTime,
      raw: data,
    }
  }

  /**
   * Completes the payment. Money moves here, not at `createPayment`, so an
   * order is only paid once this resolves.
   *
   * bKash expires an unexecuted payment within minutes of the shopper
   * returning, so call this immediately in the callback handler.
   */
  async executePayment(paymentId: string): Promise<BkashExecutedPayment> {
    requireText(paymentId, 'paymentId')

    const data = await this.authed<BkashExecutePaymentResponse>('execute', {
      paymentID: paymentId,
    })

    return {
      paymentId: data.paymentID,
      trxId: data.trxID,
      amount: data.amount,
      currency: data.currency,
      invoiceNumber: data.merchantInvoiceNumber,
      transactionStatus: data.transactionStatus,
      customerMsisdn: data.customerMsisdn,
      payerReference: data.payerReference,
      executedAt: data.paymentExecuteTime,
      raw: data,
    }
  }

  /**
   * Authoritative state of a payment. Use this when a callback never arrived,
   * or before marking an order paid off the back of a redirect you did not
   * originate.
   */
  async queryPayment(paymentId: string): Promise<BkashQueryPaymentResponse> {
    requireText(paymentId, 'paymentId')
    return this.authed<BkashQueryPaymentResponse>('payment/status', { paymentID: paymentId })
  }

  async refund(input: RefundInput): Promise<BkashRefundResponse> {
    requireText(input?.paymentId, 'paymentId')
    requireText(input.trxId, 'trxId')
    requireText(input.sku, 'sku')
    requireText(input.reason, 'reason')

    return this.authed<BkashRefundResponse>('payment/refund', {
      paymentID: input.paymentId,
      trxID: input.trxId,
      amount: formatAmount(input.amount),
      sku: input.sku,
      reason: input.reason,
    })
  }

  async searchTransaction(trxId: string): Promise<BkashSearchTransactionResponse> {
    requireText(trxId, 'trxId')
    return this.authed<BkashSearchTransactionResponse>('general/searchTransaction', {
      trxID: trxId,
    })
  }

  /**
   * Reads the `paymentID` and `status` bKash appends to your callback URL.
   * Accepts a full URL, a query string, `URLSearchParams`, or a plain object
   * (Next.js `searchParams`, Express `req.query`).
   *
   * The redirect is shopper-controlled, so treat the result as a hint: it says
   * which branch to take, never that money moved. Only `executePayment` (or
   * `queryPayment`) proves that.
   */
  static parseCallback(
    source: string | URL | URLSearchParams | Record<string, string | string[] | undefined>,
  ): BkashCallback {
    const params = toParams(source)
    const raw: Record<string, string> = {}
    for (const [key, value] of params) raw[key] = value

    const paymentId = raw.paymentID ?? raw.paymentId ?? ''
    if (!paymentId) {
      throw new ValidationError('Callback is missing `paymentID`', PROVIDER, 'paymentID')
    }

    const status = (raw.status ?? '').toLowerCase()
    const known: BkashCallbackStatus[] = ['success', 'failure', 'cancel']
    return {
      paymentId,
      status: known.includes(status as BkashCallbackStatus)
        ? (status as BkashCallbackStatus)
        : 'failure',
      raw,
    }
  }

  private async authed<T extends BkashStatusFields>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.send<T>(path, body, await this.tokens.getToken())
    } catch (error) {
      // A cached token can be revoked mid-life. One retry with a fresh grant
      // is cheap; a second failure is a real credential problem.
      if (!(error instanceof AuthError)) throw error
      await this.tokens.invalidate()
      return this.send<T>(path, body, await this.tokens.getToken())
    }
  }

  private async send<T extends BkashStatusFields>(
    path: string,
    body: Record<string, unknown>,
    idToken: string,
  ): Promise<T> {
    const { data } = await this.http.request<T>({
      method: 'POST',
      path: `${CHECKOUT}/${path}`,
      body,
      headers: { authorization: idToken, 'x-app-key': this.appKey },
      retryable: false,
    })
    assertOk(data, path)
    return data
  }

  private async grantToken(config: BkashConfig): Promise<BkashToken> {
    const { data } = await this.http.request<BkashGrantTokenResponse>({
      method: 'POST',
      path: `${CHECKOUT}/token/grant`,
      body: { app_key: config.appKey, app_secret: config.appSecret },
      headers: { username: config.username, password: config.password },
      retryable: false,
    })
    return toToken(data, 'token/grant')
  }

  private async refreshToken(config: BkashConfig, refreshToken: string): Promise<BkashToken> {
    const { data } = await this.http.request<BkashGrantTokenResponse>({
      method: 'POST',
      path: `${CHECKOUT}/token/refresh`,
      body: {
        app_key: config.appKey,
        app_secret: config.appSecret,
        refresh_token: refreshToken,
      },
      headers: { username: config.username, password: config.password },
      retryable: false,
    })
    return toToken(data, 'token/refresh')
  }
}

function toToken(data: BkashGrantTokenResponse, context: string): BkashToken {
  assertOk(data, context)
  if (!data.id_token) {
    throw new ProviderError(`${context}: response contained no id_token`, {
      provider: PROVIDER,
      response: data,
    })
  }
  // bKash reports expires_in in seconds (3600 at time of writing).
  const ttlSeconds = Number(data.expires_in)
  return {
    accessToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number.isFinite(ttlSeconds) ? ttlSeconds : 3600) * 1000,
  }
}

/**
 * bKash answers HTTP 200 for business failures too, carrying the real outcome
 * in `statusCode`. Anything but `0000` is an error.
 */
function assertOk(data: unknown, context: string): asserts data is BkashStatusFields {
  if (!data) {
    throw new ProviderError(`${context}: empty response`, { provider: PROVIDER })
  }
  if (typeof data !== 'object') {
    // The body could not be parsed into an object, so the real status code is
    // unreachable. Surface the payload instead of failing later on a missing
    // field and blaming the wrong thing.
    throw new ProviderError(`${context}: unparseable response`, {
      provider: PROVIDER,
      response: data,
    })
  }

  const { statusCode, statusMessage, errorCode, errorMessage } = data as BkashStatusFields
  const code = statusCode ?? errorCode
  if (code === undefined || code === BKASH_SUCCESS_CODE) return

  // bKash pads some messages with a trailing newline.
  const message = (statusMessage ?? errorMessage ?? 'unknown error').trim()
  throw new ProviderError(`${context}: ${message} (${code})`, {
    provider: PROVIDER,
    providerCode: code,
    response: data,
  })
}

function formatAmount(amount: number | string): string {
  const value = typeof amount === 'string' ? Number(amount) : amount
  if (!Number.isFinite(value) || value < 1) {
    throw new ValidationError('`amount` must be a number of at least 1 BDT', PROVIDER, 'amount')
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function requireText(value: unknown, field: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`\`${field}\` is required`, PROVIDER, field)
  }
}

function requireAbsoluteUrl(value: string, field: string): string {
  requireText(value, field)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ValidationError(`\`${field}\` must be an absolute URL`, PROVIDER, field)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`\`${field}\` must be an http or https URL`, PROVIDER, field)
  }
  return url.toString()
}

function toParams(
  source: string | URL | URLSearchParams | Record<string, string | string[] | undefined>,
): URLSearchParams {
  if (source instanceof URLSearchParams) return source
  if (source instanceof URL) return source.searchParams
  if (typeof source === 'string') {
    // Full URL, bare query string, or `?`-prefixed query string.
    const queryIndex = source.indexOf('?')
    return new URLSearchParams(queryIndex >= 0 ? source.slice(queryIndex + 1) : source)
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value === undefined) continue
    params.set(key, Array.isArray(value) ? (value[0] ?? '') : value)
  }
  return params
}
