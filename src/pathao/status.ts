import type { DeliveryStatus } from '../courier/types.js'

/**
 * Pathao reports far more states than Steadfast, and the useful distinction is
 * "moving" versus "stuck". A failed pickup or delivery attempt is not in
 * transit — nothing progresses until someone acts — so both map to `on_hold`
 * rather than being hidden inside `in_transit` where a merchant would never
 * notice them.
 *
 * Keys are matched case-insensitively, so `order_status` (`In_Transit`) and
 * `order_status_slug` (`in_transit`) both resolve.
 */
const STATUS_MAP: Record<string, DeliveryStatus> = {
  pending: 'pending',
  pickup_requested: 'pending',
  assigned_for_pickup: 'pending',

  picked: 'in_transit',
  at_the_sorting_hub: 'in_transit',
  in_transit: 'in_transit',
  received_at_last_mile_hub: 'in_transit',
  assigned_for_delivery: 'in_transit',

  delivered: 'delivered',
  // Settlement states that only exist after a successful delivery.
  payment_invoice: 'delivered',
  paid: 'delivered',

  partial_delivery: 'partial_delivered',
  partial_delivered: 'partial_delivered',

  return: 'returned',
  returned: 'returned',
  paid_return: 'returned',

  pickup_failed: 'on_hold',
  delivery_failed: 'on_hold',
  on_hold: 'on_hold',

  pickup_cancelled: 'cancelled',
  cancelled: 'cancelled',

  exchange: 'unknown',
}

export function toDeliveryStatus(providerStatus: string): DeliveryStatus {
  if (typeof providerStatus !== 'string') return 'unknown'
  return STATUS_MAP[providerStatus.toLowerCase()] ?? 'unknown'
}

/**
 * True for the states where the parcel is stalled and a human has to do
 * something — a failed pickup or delivery attempt, or an explicit hold.
 * Worth surfacing in a dashboard, because these do not resolve on their own.
 */
export function needsAttention(providerStatus: string): boolean {
  return toDeliveryStatus(providerStatus) === 'on_hold'
}
