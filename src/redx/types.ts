/** Raw wire shapes for the RedX open API (`v1.0.0-beta`). */

export interface RedxCreateParcelResponse {
  tracking_id: string
}

export interface RedxParcelInfo {
  tracking_id?: string
  status?: string
  customer_name?: string
  customer_phone?: string
  customer_address?: string
  merchant_invoice_id?: string | null
  cash_collection_amount?: string | number
  parcel_weight?: number
  value?: number
  instruction?: string | null
  delivery_area?: string
  delivery_area_id?: number
  charge?: number
  created_at?: string
  updated_at?: string
}

export interface RedxParcelInfoResponse {
  parcel: RedxParcelInfo
}

export interface RedxTrackingEvent {
  message_en?: string
  message_bn?: string
  time?: string
  status?: string
}

export interface RedxTrackingResponse {
  tracking?: RedxTrackingEvent[]
}

export interface RedxArea {
  id: number
  name: string
  post_code?: number | string | null
  division_name?: string
  zone_id?: number
  district_name?: string
}

export interface RedxAreasResponse {
  areas: RedxArea[]
}

export interface RedxPickupStore {
  id: number
  name: string
  address?: string
  phone?: string
  area_id?: number
  area_name?: string
  is_default_store?: boolean
}

export interface RedxPickupStoresResponse {
  pickup_stores: RedxPickupStore[]
}

export interface RedxPickupStoreResponse {
  pickup_store: RedxPickupStore
}

/** One line of `parcel_details_json`. */
export interface RedxParcelItem {
  name: string
  category?: string
  /** Declared value of this line, in BDT. */
  value?: number
  quantity?: number
}

/** RedX error bodies, as observed from the sandbox. */
export interface RedxErrorBody {
  message?: string
  /** RedX repeats the HTTP status here rather than in a `code` field. */
  status_code?: number
  /** Present on validation failures. */
  errors?: unknown
}

/**
 * Parcel statuses RedX is known to report. Its vocabulary is hyphenated where
 * Pathao's is underscored, so mapping normalizes separators.
 */
export type RedxParcelStatus =
  | 'pickup-pending'
  | 'pickup-assigned'
  | 'pickup-completed'
  | 'received-at-hub'
  | 'in-transit'
  | 'delivery-in-progress'
  | 'delivered'
  | 'partial-delivered'
  | 'delivery-failed'
  | 'return-in-progress'
  | 'returned'
  | 'hold'
  | 'cancelled'
