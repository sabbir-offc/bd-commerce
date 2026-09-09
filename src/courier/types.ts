/**
 * The shape every courier in this package normalizes to. Providers keep their
 * own vocabulary in `providerStatus` and their untouched payload in `raw`, so
 * nothing is lost by going through the common interface.
 */

export type DeliveryStatus =
  /** Created, not yet picked up. */
  | 'pending'
  /** Picked up and moving. */
  | 'in_transit'
  /** Confirmed delivered and settled. */
  | 'delivered'
  /** Some items delivered, some returned. */
  | 'partial_delivered'
  /** Came back to the merchant. */
  | 'returned'
  /** Paused at the merchant's or the courier's request. */
  | 'on_hold'
  /** Courier is reviewing the outcome; not final. See `pendingApproval`. */
  | 'in_review'
  | 'cancelled'
  /** The provider reported something this version does not map. Read `providerStatus`. */
  | 'unknown'

export interface CreateOrderInput {
  /** Your order reference. Must be unique per order at the courier. */
  invoice: string
  recipientName: string
  /** Any BD mobile format; normalized before it is sent. */
  recipientPhone: string
  recipientAddress: string
  /** Amount to collect on delivery, in BDT. Use 0 for prepaid orders. */
  codAmount: number
  /** Free-text instruction for the rider. */
  note?: string
  /** Second number to try if the first does not answer. */
  alternativePhone?: string
  recipientEmail?: string
}

export interface CourierOrder {
  provider: string
  consignmentId: string
  trackingCode: string
  invoice: string
  status: DeliveryStatus
  /** The provider's own status string, verbatim. */
  providerStatus: string
  codAmount: number
  createdAt?: string
  raw: unknown
}

export interface CourierStatus {
  provider: string
  status: DeliveryStatus
  providerStatus: string
  /**
   * True when the courier has an outcome recorded but has not settled it.
   * Do not release funds or close an order on `delivered` while this is true.
   */
  pendingApproval: boolean
  raw: unknown
}

export interface CourierBalance {
  provider: string
  /** Merchant wallet balance in BDT. */
  currentBalance: number
  raw: unknown
}

/** One entry of a bulk create. Failures are per-row, not per-batch. */
export type BulkOrderResult =
  | { ok: true; invoice: string; order: CourierOrder }
  | { ok: false; invoice: string; message: string; raw: unknown }

export interface Courier {
  readonly provider: string
  createOrder(input: CreateOrderInput): Promise<CourierOrder>
  createOrders(inputs: CreateOrderInput[]): Promise<BulkOrderResult[]>
  getStatusByConsignmentId(consignmentId: string | number): Promise<CourierStatus>
  getStatusByInvoice(invoice: string): Promise<CourierStatus>
  getStatusByTrackingCode(trackingCode: string): Promise<CourierStatus>
  getBalance(): Promise<CourierBalance>
}
