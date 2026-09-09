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
  /**
   * Stalled and needing someone's attention: paused at the merchant's or the
   * courier's request, or a pickup or delivery attempt that failed and will not
   * progress on its own.
   */
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
  /** What the courier will charge to deliver, when it says so at create time. */
  deliveryFee?: number
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

/**
 * The shared courier surface.
 *
 * Generic over its create input because couriers genuinely differ in what an
 * address is: Steadfast takes a free-text line, Pathao requires numeric city,
 * zone and area ids from its own hierarchy. Widening `CreateOrderInput` to the
 * union of every provider's needs would make required fields look optional, and
 * pretending Pathao accepts the base input would only fail at runtime.
 *
 * Code that handles couriers uniformly should parameterise on the input type it
 * actually has, rather than assume one shape fits all.
 */
export interface Courier<TCreateInput extends CreateOrderInput = CreateOrderInput> {
  readonly provider: string
  createOrder(input: TCreateInput): Promise<CourierOrder>
  createOrders(inputs: TCreateInput[]): Promise<BulkOrderResult[]>
  /** The one lookup every courier supports: its own consignment reference. */
  getStatusByConsignmentId(consignmentId: string | number): Promise<CourierStatus>

  /**
   * Optional because not every courier offers them. Steadfast can look an order
   * up by your invoice or its tracking code and report a wallet balance; Pathao
   * exposes none of the three, and claiming otherwise would only fail at call
   * time. Probe before use: `await courier.getBalance?.()`.
   */
  getStatusByInvoice?(invoice: string): Promise<CourierStatus>
  getStatusByTrackingCode?(trackingCode: string): Promise<CourierStatus>
  getBalance?(): Promise<CourierBalance>
}
