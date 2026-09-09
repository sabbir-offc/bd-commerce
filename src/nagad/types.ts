/** Raw wire shapes for the Nagad merchant checkout API. */

/** BDT. Nagad uses the ISO 4217 numeric code, as a string. */
export const NAGAD_CURRENCY_BDT = '050'

/**
 * Sent as `X-KM-Client-Type`. Nagad uses it to decide which of its checkout
 * front-ends to redirect into.
 */
export type NagadClientType = 'PC_WEB' | 'MOBILE_WEB' | 'MOBILE_APP' | 'WALLET_WEB_VIEW'

/** Both encrypted endpoints answer with this envelope. */
export interface NagadEncryptedResponse {
  /** Base64 RSA ciphertext; decrypt with the merchant private key. */
  sensitiveData: string
  /** Base64 signature over the decrypted JSON, made with Nagad's private key. */
  signature: string
  /** Present instead of the pair when Nagad rejects the request. */
  reason?: string
  message?: string
  devMessage?: string
}

/** What `check-out/initialize` encrypts into `sensitiveData`. */
export interface NagadInitializeSensitive {
  merchantId: string
  /**
   * `yyyyMMddHHmmss` in Asia/Dhaka. Note the casing: lowercase `datetime`
   * inside the encrypted payload, `dateTime` in the outer body. Nagad really
   * does spell them differently.
   */
  datetime: string
  orderId: string
  challenge: string
}

export interface NagadInitializeBody {
  accountNumber: string
  dateTime: string
  sensitiveData: string
  signature: string
}

/** Decrypted from the initialize response. */
export interface NagadInitializeDecrypted {
  paymentReferenceId: string
  /** Nagad's own challenge. It must be echoed back in `complete`. */
  challenge: string
  acceptDateTime?: string
}

/** What `check-out/complete` encrypts into `sensitiveData`. */
export interface NagadCompleteSensitive {
  merchantId: string
  orderId: string
  /** Decimal string, e.g. `"1250"`. */
  amount: string
  currencyCode: string
  challenge: string
}

export interface NagadCompleteBody {
  paymentRefId: string
  sensitiveData: string
  signature: string
  merchantCallbackURL: string
  additionalMerchantInfo?: Record<string, string>
}

export interface NagadCompleteResponse {
  status?: string
  /** Where to send the shopper. Note the capital `U`. */
  callBackUrl: string
  message?: string
}

export interface NagadVerifyResponse {
  merchantId?: string
  orderId?: string
  paymentRefId?: string
  amount?: string
  clientMobileNo?: string
  merchantMobileNo?: string
  orderDateTime?: string
  issuerPaymentDateTime?: string
  issuerPaymentRefNo?: string
  additionalMerchantInfo?: Record<string, unknown> | null
  status?: string
  statusCode?: string
}

/** Query parameters Nagad appends when it redirects the shopper back. */
export interface NagadCallbackParams {
  merchant?: string
  order_id?: string
  payment_ref_id?: string
  status?: string
  status_code?: string
  message?: string
  payment_dt_time?: string
  issuer_payment_ref?: string
}

/** Statuses Nagad reports on a payment. */
export type NagadPaymentStatus =
  'Success' | 'Aborted' | 'Cancelled' | 'Failed' | 'Initiated' | 'Pending' | 'Ready'
