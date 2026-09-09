/** Raw wire shapes for the bKash tokenized checkout API. */

/** bKash signals success with the literal string `0000`. */
export const BKASH_SUCCESS_CODE = '0000'

export interface BkashStatusFields {
  statusCode?: string
  statusMessage?: string
  /** Older endpoints use these instead of statusCode/statusMessage. */
  errorCode?: string
  errorMessage?: string
}

export interface BkashGrantTokenResponse extends BkashStatusFields {
  id_token: string
  token_type: string
  expires_in: number
  refresh_token: string
}

export interface BkashCreatePaymentResponse extends BkashStatusFields {
  paymentID: string
  bkashURL: string
  callbackURL: string
  successCallbackURL?: string
  failureCallbackURL?: string
  cancelledCallbackURL?: string
  amount: string
  intent: string
  currency: string
  paymentCreateTime: string
  transactionStatus: string
  merchantInvoiceNumber: string
}

export interface BkashExecutePaymentResponse extends BkashStatusFields {
  paymentID: string
  trxID: string
  transactionStatus: string
  amount: string
  currency: string
  intent: string
  paymentExecuteTime: string
  merchantInvoiceNumber: string
  payerReference?: string
  customerMsisdn?: string
}

export interface BkashQueryPaymentResponse extends BkashStatusFields {
  paymentID: string
  mode: string
  paymentCreateTime: string
  amount: string
  currency: string
  intent: string
  merchantInvoiceNumber: string
  transactionStatus: string
  trxID?: string
  payerReference?: string
  userVerificationStatus?: string
}

export interface BkashRefundResponse extends BkashStatusFields {
  originalTrxID: string
  refundTrxID: string
  transactionStatus: string
  amount: string
  currency: string
  charge?: string
  completedTime?: string
}

export interface BkashSearchTransactionResponse extends BkashStatusFields {
  trxID: string
  initiationTime: string
  completedTime: string
  transactionType: string
  customerMsisdn: string
  transactionStatus: string
  amount: string
  currency: string
  organizationShortCode?: string
  transactionReference?: string
}

/**
 * `mode` selects the checkout flavour. `0011` is one-off checkout without a
 * stored agreement, which is what a normal e-commerce order needs.
 */
export type BkashPaymentMode = '0000' | '0001' | '0011' | '0100' | '0101' | '0111'

/** Query string bKash appends when it redirects the shopper back. */
export type BkashCallbackStatus = 'success' | 'failure' | 'cancel'
