import type { DeliveryStatus } from '../courier/types.js'

/**
 * Steadfast's `*_approval_pending` statuses mean the rider reported an outcome
 * that the courier has not settled yet. Money still moves on the settled
 * status, so those map to `in_review` rather than to the outcome they name —
 * a merchant checking `status === 'delivered'` must not release stock or
 * refund on a report that can still flip.
 */
const STATUS_MAP: Record<string, DeliveryStatus> = {
  pending: 'pending',
  delivered: 'delivered',
  partial_delivered: 'partial_delivered',
  cancelled: 'cancelled',
  hold: 'on_hold',
  in_review: 'in_review',
  unknown: 'unknown',
  delivered_approval_pending: 'in_review',
  partial_delivered_approval_pending: 'in_review',
  cancelled_approval_pending: 'in_review',
  unknown_approval_pending: 'in_review',
}

export function toDeliveryStatus(providerStatus: string): DeliveryStatus {
  return STATUS_MAP[providerStatus?.toLowerCase?.() ?? ''] ?? 'unknown'
}

export function isPendingApproval(providerStatus: string): boolean {
  return typeof providerStatus === 'string' && providerStatus.endsWith('_approval_pending')
}

/**
 * The outcome the courier is reporting but has not settled, or `undefined`
 * when nothing is pending. Useful for optimistic dashboards that want to show
 * "delivered, awaiting approval" without treating it as final.
 */
export function reportedStatus(providerStatus: string): DeliveryStatus | undefined {
  if (!isPendingApproval(providerStatus)) return undefined
  const base = providerStatus.slice(0, -'_approval_pending'.length)
  return STATUS_MAP[base] ?? 'unknown'
}
