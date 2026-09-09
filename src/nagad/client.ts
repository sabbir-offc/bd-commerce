import { ConfigError, ProviderError, ValidationError } from '../core/errors.js'
import { HttpClient, type FetchLike } from '../core/http.js'
import {
  createNodeCrypto,
  dhakaTimestamp,
  randomChallenge,
  type NagadCryptoProvider,
  type NagadSignatureAlgorithm,
} from './crypto.js'
import { toPaymentOutcome, type PaymentOutcome } from './status.js'
import {
  NAGAD_CURRENCY_BDT,
  type NagadClientType,
  type NagadCompleteResponse,
  type NagadEncryptedResponse,
  type NagadInitializeDecrypted,
  type NagadVerifyResponse,
} from './types.js'

export const NAGAD_SANDBOX_BASE_URL = 'http://sandbox.mynagad.com/remote-payment-gateway'
export const NAGAD_LIVE_BASE_URL = 'https://api.mynagad.com'

const PROVIDER = 'nagad'
const API = 'api/dfs'

/**
 * Nagad rejects loopback addresses in `X-KM-IP-V4`, which makes every local
 * integration fail on the first call. Substituting a routable placeholder is
 * what every working implementation does.
 */
const LOOPBACK = new Set(['::1', '127.0.0.1', 'localhost', '0.0.0.0'])
const PLACEHOLDER_IP = '103.100.200.100'

export interface NagadConfig {
  merchantId: string
  /** The merchant's Nagad account number, sent as `accountNumber`. */
  merchantNumber: string
  /** Absolute URL Nagad redirects the shopper back to. */
  callbackUrl: string
  /** PEM or the bare base64 from the merchant portal. */
  merchantPrivateKey?: string
  /** PEM or bare base64. */
  nagadPublicKey?: string
  /**
   * Supply your own RSA instead of the `node:crypto` default — the way to use
   * this client outside Node. Replaces both key options.
   */
  crypto?: NagadCryptoProvider
  /** Default `SHA256`. Ignored when `crypto` is supplied. */
  signatureAlgorithm?: NagadSignatureAlgorithm
  /** Selects the sandbox base URL. Default false (live). */
  sandbox?: boolean
  baseUrl?: string
  /** Default `v-0.2.0`. */
  apiVersion?: string
  /** Default `PC_WEB`. */
  clientType?: NagadClientType
  /** The shopper's IP, for `X-KM-IP-V4`. Loopback is replaced automatically. */
  clientIp?: string
  /**
   * Check the signature on Nagad's responses. Default true. If verification
   * fails because your account was provisioned for SHA1, switch
   * `signatureAlgorithm` rather than turning this off.
   */
  verifyResponseSignature?: boolean
  timeoutMs?: number
  retries?: number
  fetch?: FetchLike
}

export interface CreateNagadPaymentInput {
  /** Your order reference. Nagad requires it to be unique per merchant. */
  orderId: string
  /** BDT. Sent as a decimal string. */
  amount: number | string
  /** Overrides the client-level callback for this payment. */
  callbackUrl?: string
  /** Free-form detail echoed back by `verifyPayment`. */
  productDetails?: Record<string, string>
  /** Overrides the client-level IP for this payment. */
  clientIp?: string
  clientType?: NagadClientType
}

export interface NagadPayment {
  /** Nagad's handle for this payment; keep it against the order. */
  paymentReferenceId: string
  /** Send the shopper here to authorize the payment. */
  redirectUrl: string
  orderId: string
  amount: string
  raw: NagadCompleteResponse
}

export interface NagadVerifiedPayment {
  orderId: string
  paymentReferenceId: string
  /** Normalized. Only `success` means the money moved. */
  outcome: PaymentOutcome
  /** Nagad's own word, verbatim. */
  providerStatus: string
  statusCode?: string
  amount?: string
  /** Nagad's transaction reference; what a customer quotes in a dispute. */
  issuerPaymentRefNo?: string
  customerMobile?: string
  paidAt?: string
  raw: NagadVerifyResponse
}

export interface NagadCallback {
  orderId: string
  paymentReferenceId: string
  outcome: PaymentOutcome
  providerStatus: string
  statusCode?: string
  message?: string
  raw: Record<string, string>
}

/**
 * Client for Nagad merchant checkout.
 *
 * **Node only.** Nagad encrypts with RSAES-PKCS1-v1_5, which WebCrypto does not
 * implement, so this subpath uses `node:crypto` and will not run on an edge
 * runtime. Pass your own `crypto` to use it elsewhere. This is also why Nagad
 * is not re-exported from the package root — importing `bd-commerce` stays
 * edge-safe.
 *
 * ```ts
 * import { NagadClient } from 'bd-commerce/nagad'
 *
 * const nagad = new NagadClient({
 *   merchantId: process.env.NAGAD_MERCHANT_ID!,
 *   merchantNumber: process.env.NAGAD_MERCHANT_NUMBER!,
 *   merchantPrivateKey: process.env.NAGAD_PRIVATE_KEY!,
 *   nagadPublicKey: process.env.NAGAD_PUBLIC_KEY!,
 *   callbackUrl: 'https://shop.example.com/api/nagad/callback',
 *   sandbox: true,
 * })
 *
 * // 1. At checkout.
 * const payment = await nagad.createPayment({ orderId: 'ORD-1042', amount: 1250 })
 * redirect(payment.redirectUrl)
 *
 * // 2. In the callback route — the redirect is a hint, not proof.
 * const { paymentReferenceId } = NagadClient.parseCallback(request.url)
 * const verified = await nagad.verifyPayment(paymentReferenceId)
 * if (verified.outcome === 'success') await markPaid(verified.orderId, verified.issuerPaymentRefNo)
 * ```
 */
export class NagadClient {
  readonly provider = PROVIDER

  private readonly http: HttpClient
  private readonly crypto: NagadCryptoProvider
  private readonly config: NagadConfig
  private readonly verifySignature: boolean

  constructor(config: NagadConfig) {
    for (const field of ['merchantId', 'merchantNumber', 'callbackUrl'] as const) {
      if (!config?.[field]) throw new ConfigError(`\`${field}\` is required`, PROVIDER)
    }
    if (!config.crypto && !(config.merchantPrivateKey && config.nagadPublicKey)) {
      throw new ConfigError(
        'Supply `merchantPrivateKey` and `nagadPublicKey`, or your own `crypto` provider',
        PROVIDER,
      )
    }

    this.config = config
    this.verifySignature = config.verifyResponseSignature ?? true
    this.crypto =
      config.crypto ??
      createNodeCrypto({
        merchantPrivateKey: config.merchantPrivateKey as string,
        nagadPublicKey: config.nagadPublicKey as string,
        ...(config.signatureAlgorithm ? { signatureAlgorithm: config.signatureAlgorithm } : {}),
      })

    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: config.baseUrl ?? (config.sandbox ? NAGAD_SANDBOX_BASE_URL : NAGAD_LIVE_BASE_URL),
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      fetch: config.fetch,
      headers: { 'X-KM-Api-Version': config.apiVersion ?? 'v-0.2.0' },
    })
  }

  /**
   * Runs both legs of Nagad's handshake — initialize, then complete — and
   * returns the URL to redirect to.
   *
   * They are one method on purpose. The challenge Nagad returns from
   * initialize has to be echoed back in complete, and a half-finished
   * handshake leaves a payment reference that can never be used.
   */
  async createPayment(input: CreateNagadPaymentInput): Promise<NagadPayment> {
    requireText(input?.orderId, 'orderId')
    const amount = formatAmount(input.amount)
    const callbackUrl = requireAbsoluteUrl(
      input.callbackUrl ?? this.config.callbackUrl,
      'callbackUrl',
    )

    const initialized = await this.initialize(input)

    const sensitive = {
      merchantId: this.config.merchantId,
      orderId: input.orderId,
      amount,
      currencyCode: NAGAD_CURRENCY_BDT,
      challenge: initialized.challenge,
    }

    const { data } = await this.http.request<NagadCompleteResponse>({
      method: 'POST',
      path: `${API}/check-out/complete/${encodeURIComponent(initialized.paymentReferenceId)}`,
      body: {
        paymentRefId: initialized.paymentReferenceId,
        sensitiveData: this.encryptJson(sensitive),
        signature: this.signJson(sensitive),
        merchantCallbackURL: callbackUrl,
        ...(input.productDetails ? { additionalMerchantInfo: input.productDetails } : {}),
      },
      headers: this.callHeaders(input),
      retryable: false,
    })

    if (!data?.callBackUrl) {
      throw new ProviderError(
        `Nagad did not return a redirect URL: ${data?.message ?? data?.status ?? 'no callBackUrl'}`,
        { provider: PROVIDER, response: data },
      )
    }

    return {
      paymentReferenceId: initialized.paymentReferenceId,
      redirectUrl: data.callBackUrl,
      orderId: input.orderId,
      amount,
      raw: data,
    }
  }

  /**
   * The authoritative outcome. Nagad's redirect is shopper-controlled, so this
   * is the only thing that proves a payment — call it before marking an order
   * paid, and again for any payment whose callback never arrived.
   */
  async verifyPayment(paymentReferenceId: string): Promise<NagadVerifiedPayment> {
    requireText(paymentReferenceId, 'paymentReferenceId')

    const { data } = await this.http.request<NagadVerifyResponse>({
      method: 'GET',
      path: `${API}/verify/payment/${encodeURIComponent(paymentReferenceId)}`,
      headers: this.callHeaders(),
    })

    if (!data || typeof data !== 'object') {
      throw new ProviderError('Nagad returned no verification body', {
        provider: PROVIDER,
        response: data,
      })
    }

    const providerStatus = data.status ?? 'unknown'
    return {
      orderId: data.orderId ?? '',
      paymentReferenceId: data.paymentRefId ?? paymentReferenceId,
      outcome: toPaymentOutcome(providerStatus),
      providerStatus,
      ...(data.statusCode ? { statusCode: data.statusCode } : {}),
      ...(data.amount ? { amount: data.amount } : {}),
      ...(data.issuerPaymentRefNo ? { issuerPaymentRefNo: data.issuerPaymentRefNo } : {}),
      ...(data.clientMobileNo ? { customerMobile: data.clientMobileNo } : {}),
      ...(data.issuerPaymentDateTime ? { paidAt: data.issuerPaymentDateTime } : {}),
      raw: data,
    }
  }

  /**
   * Reads what Nagad appends to your callback URL. Accepts a full URL, a query
   * string, `URLSearchParams`, or a plain object.
   *
   * Treat the result as a hint about which branch to take. It says nothing
   * reliable about money — only {@link NagadClient.verifyPayment} does.
   */
  static parseCallback(
    source: string | URL | URLSearchParams | Record<string, string | string[] | undefined>,
  ): NagadCallback {
    const params = toParams(source)
    const raw: Record<string, string> = {}
    for (const [key, value] of params) raw[key] = value

    const paymentReferenceId = raw.payment_ref_id ?? raw.paymentRefId ?? ''
    if (!paymentReferenceId) {
      throw new ValidationError('Callback is missing `payment_ref_id`', PROVIDER, 'payment_ref_id')
    }

    const providerStatus = raw.status ?? 'unknown'
    return {
      orderId: raw.order_id ?? '',
      paymentReferenceId,
      outcome: toPaymentOutcome(providerStatus),
      providerStatus,
      ...(raw.status_code ? { statusCode: raw.status_code } : {}),
      ...(raw.message ? { message: raw.message } : {}),
      raw,
    }
  }

  private async initialize(input: CreateNagadPaymentInput): Promise<NagadInitializeDecrypted> {
    const timestamp = dhakaTimestamp()
    const sensitive = {
      merchantId: this.config.merchantId,
      // Lowercase `datetime` here, `dateTime` in the outer body. Nagad's own
      // spelling; do not "fix" it.
      datetime: timestamp,
      orderId: input.orderId,
      challenge: randomChallenge(),
    }

    const { data } = await this.http.request<NagadEncryptedResponse>({
      method: 'POST',
      path: `${API}/check-out/initialize/${encodeURIComponent(
        this.config.merchantId,
      )}/${encodeURIComponent(input.orderId)}`,
      body: {
        accountNumber: this.config.merchantNumber,
        dateTime: timestamp,
        sensitiveData: this.encryptJson(sensitive),
        signature: this.signJson(sensitive),
      },
      headers: this.callHeaders(input),
      retryable: false,
    })

    return this.decryptResponse<NagadInitializeDecrypted>(data, 'check-out/initialize')
  }

  private decryptResponse<T>(data: NagadEncryptedResponse | null, context: string): T {
    if (!data?.sensitiveData) {
      const detail = data?.message ?? data?.reason ?? data?.devMessage ?? 'no sensitiveData'
      throw new ProviderError(`${context}: ${detail}`, { provider: PROVIDER, response: data })
    }

    // A mismatched key pair is the most common Nagad setup mistake, and it
    // surfaces in two different ways depending on the runtime. Some Node and
    // OpenSSL builds raise a padding error; others apply implicit rejection
    // (the Marvin/Bleichenbacher mitigation) and hand back random bytes that
    // then fail to parse as JSON. Measured both: Node 24 on Windows returned
    // garbage 200 times out of 200, while Node 22 on Linux threw. Both paths
    // mean the same thing, so both produce the same error.
    let plaintext: string
    try {
      plaintext = this.crypto.decrypt(data.sensitiveData)
    } catch (error) {
      throw keyMismatch(context, data, error)
    }

    // Parse before verifying: the two failures have different causes and the
    // caller needs to be told the right one.
    let parsed: T
    try {
      parsed = JSON.parse(plaintext) as T
    } catch {
      throw keyMismatch(context, data)
    }

    // Reaching here means the payload decrypted into real JSON, so the keys are
    // right and a failed signature is about the algorithm, not the key.
    if (this.verifySignature && data.signature) {
      if (!this.crypto.verify(plaintext, data.signature)) {
        throw new ProviderError(
          `${context}: response signature did not verify. If your Nagad account was provisioned for SHA1withRSA, set \`signatureAlgorithm: 'SHA1'\`.`,
          { provider: PROVIDER, response: data },
        )
      }
    }

    return parsed
  }

  private callHeaders(input?: CreateNagadPaymentInput): Record<string, string> {
    const ip = input?.clientIp ?? this.config.clientIp ?? PLACEHOLDER_IP
    return {
      'X-KM-IP-V4': LOOPBACK.has(ip) ? PLACEHOLDER_IP : ip,
      'X-KM-Client-Type': input?.clientType ?? this.config.clientType ?? 'PC_WEB',
    }
  }

  private encryptJson(value: unknown): string {
    return this.crypto.encrypt(JSON.stringify(value))
  }

  private signJson(value: unknown): string {
    return this.crypto.sign(JSON.stringify(value))
  }
}

/**
 * The merchant private key does not match the public key Nagad holds. Raised
 * from both detection paths so the caller sees one consistent message.
 */
function keyMismatch(context: string, response: unknown, cause?: unknown): ProviderError {
  return new ProviderError(
    `${context}: could not read the response, which almost always means the merchant private key does not match the public key Nagad holds for you.`,
    { provider: PROVIDER, response, ...(cause === undefined ? {} : { cause }) },
  )
}

function formatAmount(amount: number | string): string {
  const value = typeof amount === 'string' ? Number(amount) : amount
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError('`amount` must be a positive number of BDT', PROVIDER, 'amount')
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
