/**
 * The two halves of a bKash checkout, written as plain request handlers so the
 * shape is clear regardless of framework. In Next.js these are two route
 * handlers; in Express, two routes.
 *
 * Imports are relative so the example typechecks inside this repo. In your own
 * project it is `import { BkashClient } from 'bd-commerce/bkash'`.
 */
import { BkashClient } from '../src/bkash/index.js'
import { BdCommerceError } from '../src/core/errors.js'

const bkash = new BkashClient({
  appKey: process.env.BKASH_APP_KEY ?? '',
  appSecret: process.env.BKASH_APP_SECRET ?? '',
  username: process.env.BKASH_USERNAME ?? '',
  password: process.env.BKASH_PASSWORD ?? '',
  sandbox: process.env.NODE_ENV !== 'production',
  // In serverless, replace this with Redis or another shared store — see the
  // README. The default in-memory store re-grants on every cold start, and
  // bKash rate-limits grants.
})

const CALLBACK_URL = 'https://shop.example.com/api/bkash/callback'

/** POST /api/bkash/checkout — create the payment, hand back the redirect URL. */
export async function startCheckout(orderId: string, amountBdt: number) {
  const payment = await bkash.createPayment({
    amount: amountBdt,
    invoiceNumber: orderId,
    callbackURL: CALLBACK_URL,
    payerReference: orderId,
  })

  // Persist the paymentID against the order before redirecting. If the shopper
  // never comes back you still have the handle needed to reconcile.
  await savePaymentId(orderId, payment.paymentId)

  return { redirectTo: payment.bkashUrl }
}

/** GET /api/bkash/callback — bKash sends the shopper back here. */
export async function handleCallback(requestUrl: string) {
  const { paymentId, status } = BkashClient.parseCallback(requestUrl)

  if (status !== 'success') {
    return { redirectTo: `/checkout/cancelled?reason=${status}` }
  }

  try {
    // Nothing has been charged yet. This call is the payment.
    const executed = await bkash.executePayment(paymentId)
    await markOrderPaid(executed.invoiceNumber, executed.trxId)
    return { redirectTo: `/orders/${executed.invoiceNumber}?paid=1` }
  } catch (error) {
    // An execute can fail after the shopper authorized — expired window, or a
    // duplicate callback. Ask bKash what actually happened before showing a
    // failure the customer's statement will contradict.
    const state = await bkash.queryPayment(paymentId).catch(() => null)

    if (state?.transactionStatus === 'Completed') {
      await markOrderPaid(state.merchantInvoiceNumber, state.trxID ?? '')
      return { redirectTo: `/orders/${state.merchantInvoiceNumber}?paid=1` }
    }

    if (BdCommerceError.is(error)) {
      console.error(`[bkash] ${error.code} ${error.providerCode ?? ''}`, error.response)
    }
    return { redirectTo: '/checkout/failed' }
  }
}

/**
 * Nightly job: settle anything that started but never resolved. Shoppers close
 * tabs, and networks drop callbacks; without this, real payments sit unmatched.
 */
export async function reconcilePending(pending: Array<{ orderId: string; paymentId: string }>) {
  for (const { orderId, paymentId } of pending) {
    const state = await bkash.queryPayment(paymentId).catch(() => null)
    if (state?.transactionStatus === 'Completed') {
      await markOrderPaid(orderId, state.trxID ?? '')
    }
  }
}

// Stand-ins for your own persistence layer.
declare function savePaymentId(orderId: string, paymentId: string): Promise<void>
declare function markOrderPaid(orderId: string, trxId: string): Promise<void>
