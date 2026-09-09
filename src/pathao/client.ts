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
import { MemoryTokenStore, TokenManager, type AccessToken, type TokenStore } from '../core/token.js'
import { toDeliveryStatus } from './status.js'
import {
  DELIVERY_TYPE,
  ITEM_TYPE,
  type PathaoArea,
  type PathaoCity,
  type PathaoCreateOrderData,
  type PathaoDeliveryType,
  type PathaoEnvelope,
  type PathaoItemType,
  type PathaoOrderInfoData,
  type PathaoPage,
  type PathaoPriceData,
  type PathaoStore,
  type PathaoTokenResponse,
  type PathaoValidationErrorBody,
  type PathaoZone,
} from './types.js'

export const PATHAO_SANDBOX_BASE_URL = 'https://courier-api-sandbox.pathao.com'
export const PATHAO_LIVE_BASE_URL = 'https://api-hermes.pathao.com'

const PROVIDER = 'pathao'
const API = 'aladdin/api/v1'

// Pathao rejects parcels outside this range.
const MIN_WEIGHT_KG = 0.5
const MAX_WEIGHT_KG = 10
// Its address field has a documented minimum that is easy to trip with a short
// line like "Banani, Dhaka".
const MIN_ADDRESS_LENGTH = 10
const MIN_NAME_LENGTH = 3

export interface PathaoConfig {
  clientId: string
  clientSecret: string
  /**
   * Merchant account credentials. Supplying them selects the documented
   * password grant against `issue-token`; omitting them uses the
   * client-credentials `external/login` that Pathao's own WooCommerce plugin
   * uses. Only the password grant can refresh.
   */
  username?: string
  password?: string
  /** Selects the sandbox base URL. Default false (live). */
  sandbox?: boolean
  /** Overrides both sandbox and live base URLs. */
  baseUrl?: string
  /** Used for any order that does not name its own `storeId`. */
  defaultStoreId?: number
  timeoutMs?: number
  retries?: number
  fetch?: FetchLike
  /**
   * Where the access token is cached. Defaults to process memory, which is
   * wrong for serverless.
   */
  tokenStore?: TokenStore
  /** Normalize and validate recipient phones before sending. Default true. */
  validatePhone?: boolean
}

/**
 * Pathao needs more than a free-text address: city and zone are numeric ids
 * from its own hierarchy, and area is strongly recommended. Use
 * {@link PathaoClient.resolveLocation} to turn names into ids, or
 * `listCities` / `listZones` / `listAreas` to build your own picker.
 */
export interface PathaoCreateOrderInput extends CreateOrderInput {
  /** From `listCities()`. */
  recipientCity: number
  /** From `listZones(cityId)`. */
  recipientZone: number
  /** From `listAreas(zoneId)`. Optional, but delivery is more reliable with it. */
  recipientArea?: number
  /** Overrides `defaultStoreId` for this order. */
  storeId?: number
  /** Default 48 (normal). */
  deliveryType?: PathaoDeliveryType
  /** Default 2 (parcel). */
  itemType?: PathaoItemType
  /** Default 1. */
  itemQuantity?: number
  /**
   * Kilograms, 0.5 to 10. Required because it sets the delivery fee — a
   * default here would quietly misprice every order.
   */
  itemWeight: number
  itemDescription?: string
}

export interface PathaoLocationQuery {
  city: string
  zone: string
  area?: string
}

export interface PathaoLocation {
  cityId: number
  cityName: string
  zoneId: number
  zoneName: string
  areaId?: number
  areaName?: string
}

export interface PathaoPriceQuery {
  recipientCity: number
  recipientZone: number
  itemWeight: number
  storeId?: number
  deliveryType?: PathaoDeliveryType
  itemType?: PathaoItemType
}

export interface CreateStoreInput {
  name: string
  contactName: string
  contactNumber: string
  address: string
  cityId: number
  zoneId: number
  areaId: number
  secondaryContact?: string
}

/**
 * Client for the Pathao Courier merchant API.
 *
 * ```ts
 * const pathao = new PathaoClient({
 *   clientId: process.env.PATHAO_CLIENT_ID!,
 *   clientSecret: process.env.PATHAO_CLIENT_SECRET!,
 *   username: process.env.PATHAO_USERNAME!,
 *   password: process.env.PATHAO_PASSWORD!,
 *   defaultStoreId: Number(process.env.PATHAO_STORE_ID),
 *   sandbox: true,
 * })
 *
 * const where = await pathao.resolveLocation({ city: 'Dhaka', zone: 'Banani' })
 * const order = await pathao.createOrder({
 *   invoice: 'ORD-1042',
 *   recipientName: 'Rahim Uddin',
 *   recipientPhone: '01712345678',
 *   recipientAddress: 'House 4, Road 11, Banani, Dhaka',
 *   recipientCity: where.cityId,
 *   recipientZone: where.zoneId,
 *   codAmount: 1250,
 *   itemWeight: 0.5,
 * })
 * ```
 */
export class PathaoClient implements Courier<PathaoCreateOrderInput> {
  readonly provider = PROVIDER

  private readonly http: HttpClient
  private readonly tokens: TokenManager
  private readonly defaultStoreId: number | undefined
  private readonly validatePhone: boolean

  // Pathao's hierarchy is large and effectively static, so a process-lifetime
  // cache turns a three-request address lookup into one.
  private cities: PathaoCity[] | undefined
  private readonly zones = new Map<number, PathaoZone[]>()
  private readonly areas = new Map<number, PathaoArea[]>()

  constructor(config: PathaoConfig) {
    if (!config?.clientId) throw new ConfigError('`clientId` is required', PROVIDER)
    if (!config.clientSecret) throw new ConfigError('`clientSecret` is required', PROVIDER)
    if (Boolean(config.username) !== Boolean(config.password)) {
      throw new ConfigError(
        '`username` and `password` must be supplied together, or both omitted',
        PROVIDER,
      )
    }

    this.defaultStoreId = config.defaultStoreId
    this.validatePhone = config.validatePhone ?? true

    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: config.baseUrl ?? (config.sandbox ? PATHAO_SANDBOX_BASE_URL : PATHAO_LIVE_BASE_URL),
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      fetch: config.fetch,
      annotateError: annotateFieldErrors,
    })

    const usesPasswordGrant = Boolean(config.username && config.password)
    this.tokens = new TokenManager({
      store: config.tokenStore ?? new MemoryTokenStore(),
      grant: usesPasswordGrant ? () => this.issueToken(config) : () => this.externalLogin(config),
      // `external/login` has no refresh flow, so every renewal re-grants.
      ...(usesPasswordGrant
        ? { refresh: (refreshToken: string) => this.refreshToken(config, refreshToken) }
        : {}),
    })
  }

  async createOrder(input: PathaoCreateOrderInput): Promise<CourierOrder> {
    const payload = this.toPayload(input)

    const data = await this.authed<PathaoCreateOrderData>({
      method: 'POST',
      path: `${API}/orders`,
      body: payload,
      // Never replayed: a retry after a timeout would ship the parcel twice.
      retryable: false,
    })

    return toCourierOrder(data, input.codAmount)
  }

  /**
   * Pathao accepts a batch, but its per-row result shape is not documented as
   * precisely as Steadfast's. Rows that cannot be matched back to a request are
   * reported as failures rather than silently dropped.
   */
  async createOrders(inputs: PathaoCreateOrderInput[]): Promise<BulkOrderResult[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ValidationError('At least one order is required', PROVIDER, 'orders')
    }

    const payload = inputs.map((input) => this.toPayload(input))
    const data = await this.authed<unknown>({
      method: 'POST',
      path: `${API}/orders/bulk`,
      body: { orders: payload },
      retryable: false,
    })

    const rows = Array.isArray(data)
      ? data
      : Array.isArray((data as { orders?: unknown })?.orders)
        ? ((data as { orders: unknown[] }).orders as unknown[])
        : undefined

    if (!rows) {
      throw new ProviderError('Pathao returned an unrecognized bulk response', {
        provider: PROVIDER,
        response: data,
      })
    }

    return rows.map((row, index): BulkOrderResult => {
      const record = (row ?? {}) as Partial<PathaoCreateOrderData> & { message?: string }
      const invoice = record.merchant_order_id ?? payload[index]?.merchant_order_id ?? ''

      if (!record.consignment_id) {
        return { ok: false, invoice, message: record.message ?? 'no consignment id', raw: row }
      }
      return {
        ok: true,
        invoice,
        order: toCourierOrder(record as PathaoCreateOrderData, inputs[index]?.codAmount ?? 0),
      }
    })
  }

  async getStatusByConsignmentId(consignmentId: string | number): Promise<CourierStatus> {
    const id = String(consignmentId ?? '').trim()
    if (!id) throw new ValidationError('`consignmentId` is required', PROVIDER, 'consignmentId')

    const data = await this.authed<PathaoOrderInfoData>({
      method: 'GET',
      path: `${API}/orders/${encodeURIComponent(id)}`,
    })

    const providerStatus = data.order_status ?? data.order_status_slug ?? 'unknown'
    return {
      provider: PROVIDER,
      status: toDeliveryStatus(providerStatus),
      providerStatus,
      // Pathao has no "reported but unsettled" state; its statuses are final
      // as reported.
      pendingApproval: false,
      raw: data,
    }
  }

  async listCities(): Promise<PathaoCity[]> {
    if (!this.cities) {
      // Note the `countries/1` prefix. A bare `city-list` 404s, which is the
      // single most common mistake in third-party Pathao wrappers.
      const page = await this.authed<PathaoPage<PathaoCity>>({
        method: 'GET',
        path: `${API}/countries/1/city-list`,
      })
      this.cities = page.data ?? []
    }
    return this.cities
  }

  async listZones(cityId: number): Promise<PathaoZone[]> {
    requireId(cityId, 'cityId')

    let cached = this.zones.get(cityId)
    if (!cached) {
      const page = await this.authed<PathaoPage<PathaoZone>>({
        method: 'GET',
        path: `${API}/cities/${cityId}/zone-list`,
      })
      cached = page.data ?? []
      this.zones.set(cityId, cached)
    }
    return cached
  }

  async listAreas(zoneId: number): Promise<PathaoArea[]> {
    requireId(zoneId, 'zoneId')

    let cached = this.areas.get(zoneId)
    if (!cached) {
      const page = await this.authed<PathaoPage<PathaoArea>>({
        method: 'GET',
        path: `${API}/zones/${zoneId}/area-list`,
      })
      cached = page.data ?? []
      this.areas.set(zoneId, cached)
    }
    return cached
  }

  /**
   * Turns place names into the ids `createOrder` needs.
   *
   * Deliberately a separate step rather than something `createOrder` does for
   * you: silently picking the wrong zone sends a parcel to the wrong side of
   * Dhaka, and that failure is invisible until it is expensive. An ambiguous or
   * unknown name throws with the closest candidates listed.
   */
  async resolveLocation(query: PathaoLocationQuery): Promise<PathaoLocation> {
    const city = pickByName(await this.listCities(), query.city, 'city', (c) => c.city_name)
    const zone = pickByName(
      await this.listZones(city.city_id),
      query.zone,
      'zone',
      (z) => z.zone_name,
    )

    const location: PathaoLocation = {
      cityId: city.city_id,
      cityName: city.city_name,
      zoneId: zone.zone_id,
      zoneName: zone.zone_name,
    }
    if (!query.area) return location

    const area = pickByName(
      await this.listAreas(zone.zone_id),
      query.area,
      'area',
      (a) => a.area_name,
    )
    return { ...location, areaId: area.area_id, areaName: area.area_name }
  }

  async listStores(page = 1): Promise<PathaoStore[]> {
    const result = await this.authed<PathaoPage<PathaoStore>>({
      method: 'GET',
      path: `${API}/stores`,
      query: { page },
    })
    return result.data ?? []
  }

  async createStore(input: CreateStoreInput): Promise<unknown> {
    requireText(input?.name, 'name')
    requireText(input.contactName, 'contactName')
    requireText(input.address, 'address')
    requireId(input.cityId, 'cityId')
    requireId(input.zoneId, 'zoneId')
    requireId(input.areaId, 'areaId')

    return this.authed<unknown>({
      method: 'POST',
      path: `${API}/stores`,
      body: {
        name: input.name,
        contact_name: input.contactName,
        contact_number: this.phone(input.contactNumber),
        address: input.address,
        city_id: input.cityId,
        zone_id: input.zoneId,
        area_id: input.areaId,
        ...(input.secondaryContact
          ? { secondary_contact: this.phone(input.secondaryContact) }
          : {}),
      },
      retryable: false,
    })
  }

  /** What Pathao will charge for a parcel, before you commit to shipping it. */
  async calculatePrice(query: PathaoPriceQuery): Promise<PathaoPriceData> {
    requireId(query?.recipientCity, 'recipientCity')
    requireId(query.recipientZone, 'recipientZone')

    return this.authed<PathaoPriceData>({
      method: 'POST',
      path: `${API}/merchant/price-plan`,
      body: {
        store_id: this.storeId(query.storeId),
        item_type: query.itemType ?? ITEM_TYPE.parcel,
        delivery_type: query.deliveryType ?? DELIVERY_TYPE.normal,
        item_weight: this.weight(query.itemWeight),
        recipient_city: query.recipientCity,
        recipient_zone: query.recipientZone,
      },
      // A price quote is read-only despite the POST.
      retryable: true,
    })
  }

  /** Sends a request with a bearer token, re-granting once if it is rejected. */
  private async authed<T>(
    options: Omit<Parameters<HttpClient['request']>[0], 'headers'>,
  ): Promise<T> {
    try {
      return await this.send<T>(options, await this.tokens.getToken())
    } catch (error) {
      // A cached token can be revoked mid-life. One retry with a fresh grant is
      // cheap; a second failure is a real credential problem.
      if (!isAuthFailure(error)) throw error
      await this.tokens.invalidate()
      return this.send<T>(options, await this.tokens.getToken())
    }
  }

  private async send<T>(
    options: Omit<Parameters<HttpClient['request']>[0], 'headers'>,
    accessToken: string,
  ): Promise<T> {
    const { data } = await this.http.request<PathaoEnvelope<T>>({
      ...options,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    if (!data || typeof data !== 'object' || !('data' in data)) {
      throw new ProviderError(`Pathao returned no data for ${options.path}`, {
        provider: PROVIDER,
        response: data,
      })
    }
    return data.data
  }

  private async issueToken(config: PathaoConfig): Promise<AccessToken> {
    const { data } = await this.http.request<PathaoTokenResponse>({
      method: 'POST',
      path: `${API}/issue-token`,
      body: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        username: config.username,
        password: config.password,
        grant_type: 'password',
      },
      retryable: false,
    })
    return toAccessToken(data, 'issue-token')
  }

  private async refreshToken(config: PathaoConfig, refreshToken: string): Promise<AccessToken> {
    const { data } = await this.http.request<PathaoTokenResponse>({
      method: 'POST',
      path: `${API}/issue-token`,
      body: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
      retryable: false,
    })
    return toAccessToken(data, 'issue-token (refresh)')
  }

  private async externalLogin(config: PathaoConfig): Promise<AccessToken> {
    const { data } = await this.http.request<PathaoTokenResponse>({
      method: 'POST',
      path: `${API}/external/login`,
      body: { client_id: config.clientId, client_secret: config.clientSecret },
      retryable: false,
    })
    return toAccessToken(data, 'external/login')
  }

  private toPayload(input: PathaoCreateOrderInput) {
    requireText(input?.invoice, 'invoice')
    requireText(input.recipientName, 'recipientName')
    if (input.recipientName.trim().length < MIN_NAME_LENGTH) {
      throw new ValidationError(
        `\`recipientName\` must be at least ${MIN_NAME_LENGTH} characters`,
        PROVIDER,
        'recipientName',
      )
    }
    requireText(input.recipientAddress, 'recipientAddress')
    if (input.recipientAddress.trim().length < MIN_ADDRESS_LENGTH) {
      throw new ValidationError(
        `\`recipientAddress\` must be at least ${MIN_ADDRESS_LENGTH} characters; Pathao rejects short lines`,
        PROVIDER,
        'recipientAddress',
      )
    }
    requireId(input.recipientCity, 'recipientCity')
    requireId(input.recipientZone, 'recipientZone')

    const cod = Number(input.codAmount)
    if (!Number.isFinite(cod) || cod < 0) {
      throw new ValidationError(
        '`codAmount` must be a non-negative number of BDT',
        PROVIDER,
        'codAmount',
      )
    }

    const quantity = input.itemQuantity ?? 1
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ValidationError(
        '`itemQuantity` must be a positive integer',
        PROVIDER,
        'itemQuantity',
      )
    }

    return {
      store_id: this.storeId(input.storeId),
      merchant_order_id: input.invoice,
      recipient_name: input.recipientName,
      recipient_phone: this.phone(input.recipientPhone),
      recipient_address: input.recipientAddress,
      recipient_city: input.recipientCity,
      recipient_zone: input.recipientZone,
      delivery_type: input.deliveryType ?? DELIVERY_TYPE.normal,
      item_type: input.itemType ?? ITEM_TYPE.parcel,
      item_quantity: quantity,
      item_weight: this.weight(input.itemWeight),
      amount_to_collect: cod,
      ...(input.recipientArea ? { recipient_area: input.recipientArea } : {}),
      ...(input.alternativePhone
        ? { recipient_secondary_phone: this.phone(input.alternativePhone) }
        : {}),
      ...(input.itemDescription ? { item_description: input.itemDescription } : {}),
      ...(input.note ? { special_instruction: input.note } : {}),
    }
  }

  private storeId(override?: number): number {
    const storeId = override ?? this.defaultStoreId
    if (!Number.isInteger(storeId) || (storeId as number) <= 0) {
      throw new ValidationError(
        'A store is required: pass `storeId`, or set `defaultStoreId` on the client. Use `listStores()` to find yours.',
        PROVIDER,
        'storeId',
      )
    }
    return storeId as number
  }

  private weight(value: number): number {
    const weight = Number(value)
    if (!Number.isFinite(weight) || weight < MIN_WEIGHT_KG || weight > MAX_WEIGHT_KG) {
      throw new ValidationError(
        `\`itemWeight\` must be between ${MIN_WEIGHT_KG} and ${MAX_WEIGHT_KG} kg, got ${value}`,
        PROVIDER,
        'itemWeight',
      )
    }
    return weight
  }

  private phone(value: string): string {
    return this.validatePhone ? normalizeBdPhone(value, PROVIDER) : value
  }
}

function toCourierOrder(data: PathaoCreateOrderData, codAmount: number): CourierOrder {
  const providerStatus = data.order_status ?? 'Pending'
  return {
    provider: PROVIDER,
    consignmentId: String(data.consignment_id),
    // Pathao has no separate tracking code; the consignment id is what a
    // customer types into its tracking page.
    trackingCode: String(data.consignment_id),
    invoice: data.merchant_order_id ?? '',
    status: toDeliveryStatus(providerStatus),
    providerStatus,
    codAmount,
    deliveryFee: typeof data.delivery_fee === 'number' ? data.delivery_fee : undefined,
    raw: data,
  }
}

function toAccessToken(data: PathaoTokenResponse, context: string): AccessToken {
  if (!data?.access_token) {
    throw new ProviderError(`${context}: response contained no access_token`, {
      provider: PROVIDER,
      response: data,
    })
  }
  const ttlSeconds = Number(data.expires_in)
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: Date.now() + (Number.isFinite(ttlSeconds) ? ttlSeconds : 3600) * 1000,
  }
}

function isAuthFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'auth_error'
  )
}

/**
 * Pathao answers a 422 with per-field messages nested under `errors`. Flatten
 * them into the message so the caller does not have to dig through `response`
 * to learn that `recipient_address` was three characters short.
 */
function annotateFieldErrors(parsed: unknown, status: number): string | undefined {
  if (status < 400 || !parsed || typeof parsed !== 'object') return undefined

  const errors = (parsed as PathaoValidationErrorBody).errors
  if (!errors || typeof errors !== 'object') return undefined

  const parts = Object.entries(errors)
    .map(
      ([field, messages]) =>
        `${field}: ${(Array.isArray(messages) ? messages : [messages]).join(', ')}`,
    )
    .slice(0, 5)

  return parts.length ? parts.join('; ') : undefined
}

/**
 * Case-insensitive name lookup with a helpful failure. An exact match wins; a
 * single substring match is accepted; anything else is ambiguous and refused
 * rather than guessed.
 */
function pickByName<T>(items: T[], query: string, kind: string, nameOf: (item: T) => string): T {
  requireText(query, kind)
  const wanted = normalizeName(query)

  const exact = items.filter((item) => normalizeName(nameOf(item)) === wanted)
  if (exact.length === 1) return exact[0] as T

  const partial = items.filter((item) => normalizeName(nameOf(item)).includes(wanted))
  if (partial.length === 1) return partial[0] as T

  const candidates = (partial.length ? partial : items).slice(0, 5).map(nameOf).join(', ')
  const reason = partial.length > 1 ? 'is ambiguous' : 'was not found'

  throw new ValidationError(
    `${kind} "${query}" ${reason}${candidates ? `. Closest: ${candidates}` : ''}`,
    PROVIDER,
    kind,
  )
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
