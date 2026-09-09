import type {
  BulkOrderResult,
  Courier,
  CourierOrder,
  CourierStatus,
  CreateOrderInput,
} from '../courier/types.js'
import { ConfigError, ProviderError, ValidationError } from '../core/errors.js'
import { HttpClient, type FetchLike } from '../core/http.js'
import { normalizeBdPhone } from '../core/phone.js'
import { toDeliveryStatus } from './status.js'
import type {
  RedxArea,
  RedxAreasResponse,
  RedxCreateParcelResponse,
  RedxErrorBody,
  RedxParcelInfo,
  RedxParcelInfoResponse,
  RedxParcelItem,
  RedxPickupStore,
  RedxPickupStoreResponse,
  RedxPickupStoresResponse,
  RedxTrackingEvent,
  RedxTrackingResponse,
} from './types.js'

export const REDX_SANDBOX_BASE_URL = 'https://sandbox.redx.com.bd'
export const REDX_LIVE_BASE_URL = 'https://openapi.redx.com.bd'

const PROVIDER = 'redx'
const API = 'v1.0.0-beta'

/** Sanity bounds on the gram value, wide enough not to fight real parcels. */
const MIN_WEIGHT_G = 1
const MAX_WEIGHT_G = 30_000

export interface RedxConfig {
  /**
   * The merchant access token from the RedX panel. Unlike Pathao and bKash,
   * RedX issues a long-lived token rather than running an OAuth exchange, so
   * there is nothing to refresh and nothing to cache.
   */
  accessToken: string
  /** Selects the sandbox base URL. Default false (live). */
  sandbox?: boolean
  /** Overrides both sandbox and live base URLs. */
  baseUrl?: string
  /** Used for any parcel that does not name its own `pickupStoreId`. */
  defaultPickupStoreId?: number
  timeoutMs?: number
  retries?: number
  fetch?: FetchLike
  /** Normalize and validate recipient phones before sending. Default true. */
  validatePhone?: boolean
}

export interface RedxCreateOrderInput extends CreateOrderInput {
  /** From `listAreas()` or `resolveArea()`. */
  deliveryAreaId: number
  /** RedX wants the area name alongside its id. `resolveArea` returns both. */
  deliveryArea: string
  /** Overrides `defaultPickupStoreId` for this parcel. */
  pickupStoreId?: number
  /**
   * Weight in **grams**, as a whole number.
   *
   * RedX measures in grams where Pathao measures in kilograms. The name says
   * so and non-integers are rejected, because `0.5` meaning half a kilo would
   * otherwise sail through as half a gram.
   */
  parcelWeightGrams: number
  /** Declared value in BDT, used for compensation if the parcel is lost. */
  declaredValue?: number
  /** Becomes `parcel_details_json`; serialized for you. */
  items?: RedxParcelItem[]
}

/**
 * Client for the RedX open API.
 *
 * ```ts
 * const redx = new RedxClient({
 *   accessToken: process.env.REDX_ACCESS_TOKEN!,
 *   defaultPickupStoreId: Number(process.env.REDX_STORE_ID),
 * })
 *
 * const area = await redx.resolveArea('Banani')
 * const order = await redx.createOrder({
 *   invoice: 'ORD-1042',
 *   recipientName: 'Rahim Uddin',
 *   recipientPhone: '01712345678',
 *   recipientAddress: 'House 4, Road 11, Banani, Dhaka',
 *   deliveryAreaId: area.id,
 *   deliveryArea: area.name,
 *   codAmount: 1250,
 *   parcelWeightGrams: 500,
 * })
 * ```
 */
export class RedxClient implements Courier<RedxCreateOrderInput> {
  readonly provider = PROVIDER

  private readonly http: HttpClient
  private readonly defaultPickupStoreId: number | undefined
  private readonly validatePhone: boolean

  // The area list is large and effectively static.
  private areaCache: RedxArea[] | undefined

  constructor(config: RedxConfig) {
    if (!config?.accessToken) throw new ConfigError('`accessToken` is required', PROVIDER)

    this.defaultPickupStoreId = config.defaultPickupStoreId
    this.validatePhone = config.validatePhone ?? true

    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: config.baseUrl ?? (config.sandbox ? REDX_SANDBOX_BASE_URL : REDX_LIVE_BASE_URL),
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      fetch: config.fetch,
      headers: {
        // RedX's own header, carrying a Bearer value. Not `Authorization`.
        'API-ACCESS-TOKEN': `Bearer ${config.accessToken}`,
      },
      annotateError: annotateFieldErrors,
    })
  }

  async createOrder(input: RedxCreateOrderInput): Promise<CourierOrder> {
    const payload = this.toPayload(input)

    const { data } = await this.http.request<RedxCreateParcelResponse>({
      method: 'POST',
      path: `${API}/parcel`,
      body: payload,
      // Never replayed: a retry after a timeout would ship the parcel twice.
      retryable: false,
    })

    if (!data?.tracking_id) {
      throw new ProviderError('RedX returned no tracking id', {
        provider: PROVIDER,
        response: data,
      })
    }

    return {
      provider: PROVIDER,
      // RedX has one reference for both, and its tracking id is what a
      // customer types into the public tracking page.
      consignmentId: data.tracking_id,
      trackingCode: data.tracking_id,
      invoice: input.invoice,
      // Create returns only the id, so the status is the known initial one
      // rather than something echoed back.
      status: 'pending',
      providerStatus: 'pickup-pending',
      codAmount: Number(input.codAmount),
      raw: data,
    }
  }

  /**
   * RedX has no batch endpoint, so this posts each parcel in sequence and
   * reports per-row outcomes. Sequential rather than parallel on purpose: a
   * burst of creates is the fastest way to get rate limited, and a partially
   * applied batch is harder to reason about than a slow one.
   */
  async createOrders(inputs: RedxCreateOrderInput[]): Promise<BulkOrderResult[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ValidationError('At least one order is required', PROVIDER, 'orders')
    }

    // Validate everything first: a bad row at index 40 should not leave 39
    // real parcels behind it.
    inputs.forEach((input) => this.toPayload(input))

    const results: BulkOrderResult[] = []
    for (const input of inputs) {
      try {
        results.push({ ok: true, invoice: input.invoice, order: await this.createOrder(input) })
      } catch (error) {
        results.push({
          ok: false,
          invoice: input.invoice,
          message: error instanceof Error ? error.message : String(error),
          raw: error,
        })
      }
    }
    return results
  }

  async getStatusByConsignmentId(consignmentId: string | number): Promise<CourierStatus> {
    return this.getStatusByTrackingCode(String(consignmentId ?? ''))
  }

  /** RedX's tracking id is its only order reference, so this is the lookup. */
  async getStatusByTrackingCode(trackingCode: string): Promise<CourierStatus> {
    const id = String(trackingCode ?? '').trim()
    if (!id) throw new ValidationError('`trackingCode` is required', PROVIDER, 'trackingCode')

    const { data } = await this.http.request<RedxParcelInfoResponse>({
      method: 'GET',
      path: `${API}/parcel/info/${encodeURIComponent(id)}`,
    })

    const parcel = data?.parcel
    if (!parcel) {
      throw new ProviderError('RedX returned no parcel', { provider: PROVIDER, response: data })
    }

    const providerStatus = parcel.status ?? 'unknown'
    return {
      provider: PROVIDER,
      status: toDeliveryStatus(providerStatus),
      providerStatus,
      // RedX reports settled statuses; it has no approval-pending concept.
      pendingApproval: false,
      raw: parcel,
    }
  }

  /** Full event history, newest last. Useful for a customer-facing timeline. */
  async track(trackingCode: string): Promise<RedxTrackingEvent[]> {
    const id = String(trackingCode ?? '').trim()
    if (!id) throw new ValidationError('`trackingCode` is required', PROVIDER, 'trackingCode')

    const { data } = await this.http.request<RedxTrackingResponse>({
      method: 'GET',
      path: `${API}/parcel/track/${encodeURIComponent(id)}`,
    })
    return data?.tracking ?? []
  }

  async listAreas(): Promise<RedxArea[]> {
    if (!this.areaCache) {
      const { data } = await this.http.request<RedxAreasResponse>({
        method: 'GET',
        path: `${API}/areas`,
      })
      this.areaCache = data?.areas ?? []
    }
    return this.areaCache
  }

  /**
   * Turns an area name into the id and name `createOrder` needs.
   *
   * Like Pathao's `resolveLocation`, this refuses an ambiguous or unknown name
   * rather than guessing, and lists the closest candidates.
   */
  async resolveArea(name: string): Promise<RedxArea> {
    requireText(name, 'area')
    const areas = await this.listAreas()
    const wanted = normalizeName(name)

    const exact = areas.filter((area) => normalizeName(area.name) === wanted)
    if (exact.length === 1) return exact[0] as RedxArea

    const partial = areas.filter((area) => normalizeName(area.name).includes(wanted))
    if (partial.length === 1) return partial[0] as RedxArea

    const candidates = (partial.length ? partial : areas)
      .slice(0, 5)
      .map((area) => area.name)
      .join(', ')
    const reason = partial.length > 1 ? 'is ambiguous' : 'was not found'

    throw new ValidationError(
      `area "${name}" ${reason}${candidates ? `. Closest: ${candidates}` : ''}`,
      PROVIDER,
      'area',
    )
  }

  async listPickupStores(): Promise<RedxPickupStore[]> {
    const { data } = await this.http.request<RedxPickupStoresResponse>({
      method: 'GET',
      path: `${API}/pickup/stores`,
    })
    return data?.pickup_stores ?? []
  }

  async getPickupStore(storeId: number): Promise<RedxPickupStore> {
    requireId(storeId, 'storeId')

    const { data } = await this.http.request<RedxPickupStoreResponse>({
      method: 'GET',
      path: `${API}/pickup/store/info/${storeId}`,
    })
    if (!data?.pickup_store) {
      throw new ProviderError('RedX returned no pickup store', {
        provider: PROVIDER,
        response: data,
      })
    }
    return data.pickup_store
  }

  private toPayload(input: RedxCreateOrderInput) {
    requireText(input?.invoice, 'invoice')
    requireText(input.recipientName, 'recipientName')
    requireText(input.recipientAddress, 'recipientAddress')
    requireText(input.deliveryArea, 'deliveryArea')
    requireId(input.deliveryAreaId, 'deliveryAreaId')

    const cod = Number(input.codAmount)
    if (!Number.isFinite(cod) || cod < 0) {
      throw new ValidationError(
        '`codAmount` must be a non-negative number of BDT',
        PROVIDER,
        'codAmount',
      )
    }

    return {
      customer_name: input.recipientName,
      customer_phone: this.phone(input.recipientPhone),
      customer_address: input.recipientAddress,
      delivery_area: input.deliveryArea,
      delivery_area_id: input.deliveryAreaId,
      merchant_invoice_id: input.invoice,
      cash_collection_amount: cod,
      parcel_weight: this.weight(input.parcelWeightGrams),
      value: Number.isFinite(input.declaredValue) ? input.declaredValue : cod,
      pickup_store_id: this.pickupStoreId(input.pickupStoreId),
      ...(input.note ? { instruction: input.note } : {}),
      ...(input.items?.length
        ? { parcel_details_json: JSON.stringify(input.items.map(toParcelDetail)) }
        : {}),
    }
  }

  private pickupStoreId(override?: number): number {
    const storeId = override ?? this.defaultPickupStoreId
    if (!Number.isInteger(storeId) || (storeId as number) <= 0) {
      throw new ValidationError(
        'A pickup store is required: pass `pickupStoreId`, or set `defaultPickupStoreId` on the client. Use `listPickupStores()` to find yours.',
        PROVIDER,
        'pickupStoreId',
      )
    }
    return storeId as number
  }

  private weight(value: number): number {
    // Rejecting non-integers is the point: someone porting a Pathao
    // integration would otherwise pass 0.5 meaning half a kilogram and ship a
    // half-gram parcel.
    if (!Number.isInteger(value)) {
      throw new ValidationError(
        `\`parcelWeightGrams\` must be a whole number of grams — RedX measures in grams, not kilograms — got ${value}`,
        PROVIDER,
        'parcelWeightGrams',
      )
    }
    if (value < MIN_WEIGHT_G || value > MAX_WEIGHT_G) {
      throw new ValidationError(
        `\`parcelWeightGrams\` must be between ${MIN_WEIGHT_G} and ${MAX_WEIGHT_G} grams, got ${value}`,
        PROVIDER,
        'parcelWeightGrams',
      )
    }
    return value
  }

  private phone(value: string): string {
    return this.validatePhone ? normalizeBdPhone(value, PROVIDER) : value
  }
}

function toParcelDetail(item: RedxParcelItem) {
  requireText(item?.name, 'items[].name')
  return {
    name: item.name,
    ...(item.category ? { category: item.category } : {}),
    ...(Number.isFinite(item.value) ? { value: item.value } : {}),
    ...(Number.isFinite(item.quantity) ? { quantity: item.quantity } : {}),
  }
}

/** Surfaces RedX's validation detail in the message rather than burying it. */
function annotateFieldErrors(parsed: unknown, status: number): string | undefined {
  if (status < 400 || !parsed || typeof parsed !== 'object') return undefined

  const errors = (parsed as RedxErrorBody).errors
  if (!errors) return undefined

  if (typeof errors === 'string') return errors
  if (Array.isArray(errors)) return errors.slice(0, 5).map(String).join('; ')

  return Object.entries(errors as Record<string, unknown>)
    .slice(0, 5)
    .map(([field, message]) => `${field}: ${Array.isArray(message) ? message.join(', ') : message}`)
    .join('; ')
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function requireText(value: unknown, field: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`\`${field}\` is required`, PROVIDER, field)
  }
}

function requireId(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ValidationError(`\`${field}\` must be a positive integer id`, PROVIDER, field)
  }
}

export type { RedxParcelInfo }
