import type {
  BulkOrderResult,
  Courier,
  CourierBalance,
  CourierOrder,
  CourierStatus,
  CreateOrderInput,
} from '../courier/types.js'
import { ConfigError, ProviderError, ValidationError } from '../core/errors.js'
import { HttpClient, type FetchLike } from '../core/http.js'
import { normalizeBdPhone } from '../core/phone.js'
import { isPendingApproval, toDeliveryStatus } from './status.js'
import type {
  SteadfastBalanceResponse,
  SteadfastBulkRow,
  SteadfastConsignment,
  SteadfastCreateOrderResponse,
  SteadfastEnvelope,
  SteadfastStatusResponse,
} from './types.js'

export const STEADFAST_BASE_URL = 'https://portal.packzy.com/api/v1'

/** Steadfast rejects bulk requests above this size. */
export const STEADFAST_BULK_LIMIT = 500

const PROVIDER = 'steadfast'

// Field limits enforced by the Steadfast form. Checking locally turns a vague
// 400 into a named field error before a request is spent.
const MAX_NAME = 100
const MAX_ADDRESS = 250
const MAX_NOTE = 500

export interface SteadfastConfig {
  apiKey: string
  secretKey: string
  /** Override for staging or a proxy. Defaults to {@link STEADFAST_BASE_URL}. */
  baseUrl?: string
  /** Per-attempt timeout in ms. Default 20000. */
  timeoutMs?: number
  /** Retries for replayable requests. Order creation is never replayed. */
  retries?: number
  fetch?: FetchLike
  /**
   * Normalize and validate recipient phone numbers before sending.
   * Default true. Turn off only if you already normalize upstream.
   */
  validatePhone?: boolean
}

/**
 * Client for the Steadfast Courier merchant API.
 *
 * ```ts
 * const steadfast = new SteadfastClient({
 *   apiKey: process.env.STEADFAST_API_KEY!,
 *   secretKey: process.env.STEADFAST_SECRET_KEY!,
 * })
 * const order = await steadfast.createOrder({
 *   invoice: 'ORD-1042',
 *   recipientName: 'Rahim Uddin',
 *   recipientPhone: '01712345678',
 *   recipientAddress: 'House 4, Road 11, Banani, Dhaka',
 *   codAmount: 1250,
 * })
 * ```
 */
export class SteadfastClient implements Courier {
  readonly provider = PROVIDER

  private readonly http: HttpClient
  private readonly validatePhone: boolean

  constructor(config: SteadfastConfig) {
    if (!config?.apiKey) throw new ConfigError('`apiKey` is required', PROVIDER)
    if (!config.secretKey) throw new ConfigError('`secretKey` is required', PROVIDER)

    this.validatePhone = config.validatePhone ?? true
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: config.baseUrl ?? STEADFAST_BASE_URL,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      fetch: config.fetch,
      headers: {
        'Api-Key': config.apiKey,
        'Secret-Key': config.secretKey,
      },
      annotateError: annotateAttemptsLeft,
    })
  }

  async createOrder(input: CreateOrderInput): Promise<CourierOrder> {
    const payload = this.toPayload(input)

    const { data } = await this.http.request<SteadfastCreateOrderResponse>({
      method: 'POST',
      path: 'create_order',
      body: payload,
      // Never replayed: a retry after a timeout would ship the parcel twice.
      retryable: false,
    })

    assertOk(data, 'Failed to create consignment')
    if (!data.consignment) {
      throw new ProviderError('Steadfast returned no consignment', {
        provider: PROVIDER,
        response: data,
      })
    }
    return toCourierOrder(data.consignment)
  }

  /**
   * Creates up to {@link STEADFAST_BULK_LIMIT} consignments in one request.
   * Rows fail individually, so inspect each result rather than assuming the
   * batch succeeded as a whole.
   */
  async createOrders(inputs: CreateOrderInput[]): Promise<BulkOrderResult[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ValidationError('At least one order is required', PROVIDER, 'orders')
    }
    if (inputs.length > STEADFAST_BULK_LIMIT) {
      throw new ValidationError(
        `Steadfast accepts at most ${STEADFAST_BULK_LIMIT} orders per bulk request, got ${inputs.length}`,
        PROVIDER,
        'orders',
      )
    }

    const payload = inputs.map((input) => this.toPayload(input))
    const { data } = await this.http.request<SteadfastBulkRow[] | SteadfastEnvelope>({
      method: 'POST',
      path: 'create_order/bulk-order',
      body: { data: payload },
      retryable: false,
    })

    if (!Array.isArray(data)) {
      assertOk(data, 'Failed to create bulk consignments')
      throw new ProviderError('Steadfast returned no bulk rows', {
        provider: PROVIDER,
        response: data,
      })
    }

    return data.map((row, index): BulkOrderResult => {
      const invoice = row.invoice ?? payload[index]?.invoice ?? ''
      const succeeded =
        row.status?.toLowerCase() === 'success' && row.consignment_id != null && row.tracking_code

      if (!succeeded) {
        return { ok: false, invoice, message: row.status ?? 'unknown error', raw: row }
      }
      return {
        ok: true,
        invoice,
        order: toCourierOrder({
          consignment_id: row.consignment_id as number,
          invoice,
          tracking_code: row.tracking_code as string,
          recipient_name: row.recipient_name ?? '',
          recipient_phone: row.recipient_phone ?? '',
          recipient_address: row.recipient_address ?? '',
          cod_amount: row.cod_amount ?? 0,
          // Bulk rows report the request outcome, not a delivery status.
          status: 'pending',
          note: row.note ?? null,
        }),
      }
    })
  }

  getStatusByConsignmentId(consignmentId: string | number): Promise<CourierStatus> {
    return this.getStatus('status_by_cid', consignmentId, 'consignmentId')
  }

  getStatusByInvoice(invoice: string): Promise<CourierStatus> {
    return this.getStatus('status_by_invoice', invoice, 'invoice')
  }

  getStatusByTrackingCode(trackingCode: string): Promise<CourierStatus> {
    return this.getStatus('status_by_trackingcode', trackingCode, 'trackingCode')
  }

  async getBalance(): Promise<CourierBalance> {
    const { data } = await this.http.request<SteadfastBalanceResponse>({
      method: 'GET',
      path: 'get_balance',
    })
    assertOk(data, 'Failed to read balance')

    return {
      provider: PROVIDER,
      currentBalance: Number(data.current_balance ?? 0),
      raw: data,
    }
  }

  private async getStatus(
    endpoint: string,
    value: string | number,
    field: string,
  ): Promise<CourierStatus> {
    if (value === undefined || value === null || `${value}`.trim() === '') {
      throw new ValidationError(`\`${field}\` is required`, PROVIDER, field)
    }

    const { data } = await this.http.request<SteadfastStatusResponse>({
      method: 'GET',
      path: `${endpoint}/${encodeURIComponent(String(value))}`,
    })
    assertOk(data, 'Failed to read delivery status')

    const providerStatus = data.delivery_status ?? 'unknown'
    return {
      provider: PROVIDER,
      status: toDeliveryStatus(providerStatus),
      providerStatus,
      pendingApproval: isPendingApproval(providerStatus),
      raw: data,
    }
  }

  private toPayload(input: CreateOrderInput) {
    requireText(input?.invoice, 'invoice')
    requireText(input.recipientName, 'recipientName', MAX_NAME)
    requireText(input.recipientAddress, 'recipientAddress', MAX_ADDRESS)

    if (input.note !== undefined && input.note !== null && input.note.length > MAX_NOTE) {
      throw new ValidationError(`\`note\` must be at most ${MAX_NOTE} characters`, PROVIDER, 'note')
    }

    const cod = Number(input.codAmount)
    if (!Number.isFinite(cod) || cod < 0) {
      throw new ValidationError(
        '`codAmount` must be a non-negative number of BDT',
        PROVIDER,
        'codAmount',
      )
    }

    const phone = this.validatePhone
      ? normalizeBdPhone(input.recipientPhone, PROVIDER)
      : input.recipientPhone

    return {
      invoice: input.invoice,
      recipient_name: input.recipientName,
      recipient_phone: phone,
      recipient_address: input.recipientAddress,
      cod_amount: cod,
      ...(input.note ? { note: input.note } : {}),
      ...(input.alternativePhone
        ? {
            alternative_phone: this.validatePhone
              ? normalizeBdPhone(input.alternativePhone, PROVIDER)
              : input.alternativePhone,
          }
        : {}),
      ...(input.recipientEmail ? { recipient_email: input.recipientEmail } : {}),
    }
  }
}

/**
 * Steadfast counts down `attempts_left` on rejected credentials and locks the
 * key when it reaches zero. A merchant debugging a typo in production needs to
 * see that before they burn the rest, so it goes in the error message.
 */
function annotateAttemptsLeft(parsed: unknown, status: number): string | undefined {
  if (status !== 401 && status !== 403) return undefined
  if (!parsed || typeof parsed !== 'object') return undefined

  const attempts = (parsed as { attempts_left?: unknown }).attempts_left
  if (typeof attempts !== 'number') return undefined

  return attempts <= 0
    ? 'no attempts left, this API key is locked'
    : `${attempts} credential ${attempts === 1 ? 'attempt' : 'attempts'} left before the key is locked`
}

function toCourierOrder(consignment: SteadfastConsignment): CourierOrder {
  const providerStatus = consignment.status ?? 'pending'
  return {
    provider: PROVIDER,
    consignmentId: String(consignment.consignment_id),
    trackingCode: consignment.tracking_code,
    invoice: consignment.invoice,
    status: toDeliveryStatus(providerStatus),
    providerStatus,
    codAmount: Number(consignment.cod_amount ?? 0),
    createdAt: consignment.created_at,
    raw: consignment,
  }
}

/**
 * Steadfast answers HTTP 200 with an in-body `status`, so a transport success
 * is not a business success.
 */
function assertOk(data: SteadfastEnvelope | null | undefined, context: string): void {
  if (data && Number(data.status) === 200) return

  throw new ProviderError(`${context}: ${data?.message ?? 'unexpected response'}`, {
    provider: PROVIDER,
    status: data?.status,
    response: data,
  })
}

function requireText(value: unknown, field: string, max?: number): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`\`${field}\` is required`, PROVIDER, field)
  }
  if (max !== undefined && value.length > max) {
    throw new ValidationError(`\`${field}\` must be at most ${max} characters`, PROVIDER, field)
  }
}
