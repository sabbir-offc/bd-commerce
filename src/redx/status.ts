import type { DeliveryStatus } from '../courier/types.js'

/**
 * RedX hyphenates where Pathao underscores, and it reports pickup and delivery
 * failures the same way Pathao does. The same rule applies: a failed attempt is
 * not "in transit" — nothing moves until someone acts — so those land on
 * `on_hold` where a merchant will actually see them.
 *
 * Keys are normalized on both separators, so `in-transit`, `in_transit` and
 * `In Transit` all resolve.
 */
const STATUS_MAP: Record<string, DeliveryStatus> = {
  'pickup-pending': 'pending',
  'pickup-assigned': 'pending',
  pending: 'pending',

  'pickup-completed': 'in_transit',
  'received-at-hub': 'in_transit',
  'hub-in': 'in_transit',
  'in-transit': 'in_transit',
  'delivery-in-progress': 'in_transit',
  'agent-assigned': 'in_transit',

  delivered: 'delivered',
  'partial-delivered': 'partial_delivered',
  'partial-delivery': 'partial_delivered',

  'return-in-progress': 'returned',
  returned: 'returned',
  'returned-to-merchant': 'returned',

  'pickup-failed': 'on_hold',
  'delivery-failed': 'on_hold',
  hold: 'on_hold',
  'on-hold': 'on_hold',

  cancelled: 'cancelled',
  canceled: 'cancelled',
}

/** Lower-cases and collapses `_`, spaces and repeated `-` to a single `-`. */
function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
}

export function toDeliveryStatus(providerStatus: string): DeliveryStatus {
  if (typeof providerStatus !== 'string') return 'unknown'
  return STATUS_MAP[normalize(providerStatus)] ?? 'unknown'
}

/** True where the parcel is stalled and needs a human. */
export function needsAttention(providerStatus: string): boolean {
  return toDeliveryStatus(providerStatus) === 'on_hold'
}
