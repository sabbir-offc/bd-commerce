/** Raw wire shapes for the Pathao Courier merchant API. */

/**
 * Pathao wraps everything in this envelope. `type` is `success` or `error`,
 * and `code` repeats the HTTP status.
 */
export interface PathaoEnvelope<T> {
  message?: string
  type?: string
  code?: number
  data: T
}

/**
 * List endpoints nest a page inside `data`. The pagination fields are as
 * observed from the sandbox on 2026-09-09; all are optional because Pathao
 * does not return the same set on every endpoint.
 */
export interface PathaoPage<T> {
  data: T[]
  total?: number
  total_in_page?: number
  current_page?: number
  per_page?: number
  last_page?: number
  path?: string
  from?: number
  to?: number
  first_page_url?: string | null
  last_page_url?: string | null
  next_page_url?: string | null
  prev_page_url?: string | null
}

/** 422 responses carry per-field messages. */
export interface PathaoValidationErrorBody {
  message?: string
  type?: string
  code?: number
  errors?: Record<string, string[]>
}

export interface PathaoTokenResponse {
  token_type: string
  expires_in: number
  access_token: string
  refresh_token?: string
}

export interface PathaoCreateOrderData {
  consignment_id: string
  merchant_order_id: string | null
  order_status: string
  delivery_fee: number
}

export interface PathaoOrderInfoData {
  consignment_id: string
  merchant_order_id: string | null
  order_status: string
  order_status_slug?: string
  updated_at?: string
  invoice_id?: string | null
}

export interface PathaoCity {
  city_id: number
  city_name: string
}

export interface PathaoZone {
  zone_id: number
  zone_name: string
}

export interface PathaoArea {
  area_id: number
  area_name: string
  home_delivery_available?: boolean
  pickup_available?: boolean
}

export interface PathaoStore {
  store_id: number
  store_name: string
  /** Opaque id Pathao uses in its own panel URLs. */
  hash_id?: string
  store_address?: string
  is_active?: number
  city_id?: number
  zone_id?: number
  hub_id?: number
  is_default_store?: boolean
  is_default_return_store?: boolean
}

export interface PathaoPriceData {
  price: number
  discount: number
  /** e.g. `flat` or `percentage`; describes how `discount` was applied. */
  discount_type?: string
  promo_discount?: number
  plan_id?: number
  cod_enabled?: number
  cod_percentage?: number
  cod_discount?: number
  additional_charge?: number
  final_price: number
}

/**
 * 48 is standard delivery, 12 is on-demand. Pathao uses the numbers directly
 * in the payload, so they are modelled as literals rather than a friendly enum
 * that would need translating back.
 */
export const DELIVERY_TYPE = {
  /** Standard, next-day in most areas. */
  normal: 48,
  /** On demand, same day. */
  onDemand: 12,
} as const

export type PathaoDeliveryType = (typeof DELIVERY_TYPE)[keyof typeof DELIVERY_TYPE]

export const ITEM_TYPE = {
  document: 1,
  parcel: 2,
} as const

export type PathaoItemType = (typeof ITEM_TYPE)[keyof typeof ITEM_TYPE]

/** Every `order_status` Pathao is known to report, for exhaustive mapping. */
export type PathaoOrderStatus =
  | 'Pending'
  | 'Pickup_Requested'
  | 'Assigned_for_Pickup'
  | 'Picked'
  | 'Pickup_Failed'
  | 'Pickup_Cancelled'
  | 'At_the_Sorting_HUB'
  | 'In_Transit'
  | 'Received_at_Last_Mile_HUB'
  | 'Assigned_for_Delivery'
  | 'Delivered'
  | 'Partial_Delivery'
  | 'Return'
  | 'Delivery_Failed'
  | 'On_Hold'
  | 'Payment_Invoice'
  | 'Exchange'
  | 'Cancelled'
