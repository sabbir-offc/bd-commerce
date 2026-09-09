/**
 * Normalized payment outcome, shared in spirit with the courier statuses: the
 * caller should be able to branch on one word without learning a provider's
 * vocabulary, while the original stays available.
 */
export type PaymentOutcome = 'success' | 'failed' | 'cancelled' | 'pending' | 'unknown'

const OUTCOME_MAP: Record<string, PaymentOutcome> = {
  success: 'success',
  // Nagad's verify endpoint reports a completed payment as `Success`; its
  // callback uses the same word.
  ready: 'pending',
  initiated: 'pending',
  pending: 'pending',
  // `Aborted` is the shopper backing out of the Nagad screen; `Cancelled` is
  // an explicit cancel. Both mean no money moved and the order is not paid.
  aborted: 'cancelled',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  failed: 'failed',
  failure: 'failed',
}

export function toPaymentOutcome(providerStatus: string): PaymentOutcome {
  if (typeof providerStatus !== 'string') return 'unknown'
  return OUTCOME_MAP[providerStatus.trim().toLowerCase()] ?? 'unknown'
}

/**
 * True only for an outcome that means the money moved. Anything else — including
 * `unknown` — must not mark an order paid.
 */
export function isPaid(providerStatus: string): boolean {
  return toPaymentOutcome(providerStatus) === 'success'
}
