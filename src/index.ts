/**
 * bd-commerce — typed clients for Bangladeshi courier and payment providers.
 *
 * This barrel is written out by hand rather than re-exporting `*` from each
 * provider. Providers legitimately share helper names — each has its own
 * `toDeliveryStatus` — and a wildcard would leave which one you imported down
 * to file order. Import a subpath when you want a provider's own vocabulary:
 *
 * ```ts
 * import { SteadfastClient } from 'bd-commerce/steadfast'
 * import { BkashClient } from 'bd-commerce/bkash'
 * import { PathaoClient } from 'bd-commerce/pathao'
 * import { RedxClient } from 'bd-commerce/redx'
 * ```
 *
 * Nagad is intentionally NOT re-exported here. It needs `node:crypto` for
 * RSAES-PKCS1-v1_5, which WebCrypto does not implement, and pulling that into
 * the root would cost every other consumer the ability to run on an edge
 * runtime. Import it from `bd-commerce/nagad`.
 */

export {
  AuthError,
  BdCommerceError,
  ConfigError,
  HttpError,
  NetworkError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ValidationError,
  type BdCommerceErrorCode,
} from './core/errors.js'

export { isBdPhone, normalizeBdPhone, toInternational, type BdLocalPhone } from './core/phone.js'

export type { FetchLike } from './core/http.js'

export { MemoryTokenStore, TokenManager, type AccessToken, type TokenStore } from './core/token.js'

export type {
  BulkOrderResult,
  Courier,
  CourierBalance,
  CourierOrder,
  CourierStatus,
  CreateOrderInput,
  DeliveryStatus,
} from './courier/types.js'

// --- Steadfast ---------------------------------------------------------------

export {
  SteadfastClient,
  STEADFAST_BASE_URL,
  STEADFAST_BULK_LIMIT,
  type SteadfastConfig,
} from './steadfast/client.js'
export {
  isPendingApproval,
  reportedStatus,
  toDeliveryStatus as toSteadfastDeliveryStatus,
} from './steadfast/status.js'
export type {
  SteadfastBalanceResponse,
  SteadfastBulkRow,
  SteadfastConsignment,
  SteadfastCreateOrderResponse,
  SteadfastDeliveryStatus,
  SteadfastEnvelope,
  SteadfastStatusResponse,
} from './steadfast/types.js'

// --- bKash -------------------------------------------------------------------

export {
  BkashClient,
  BKASH_LIVE_BASE_URL,
  BKASH_SANDBOX_BASE_URL,
  type BkashCallback,
  type BkashConfig,
  type BkashExecutedPayment,
  type BkashPayment,
  type CreatePaymentInput,
  type RefundInput,
} from './bkash/client.js'
export type { BkashToken, BkashTokenStore } from './bkash/token.js'
export {
  BKASH_SUCCESS_CODE,
  type BkashCallbackStatus,
  type BkashCreatePaymentResponse,
  type BkashExecutePaymentResponse,
  type BkashGrantTokenResponse,
  type BkashPaymentMode,
  type BkashQueryPaymentResponse,
  type BkashRefundResponse,
  type BkashSearchTransactionResponse,
} from './bkash/types.js'

// --- Pathao ------------------------------------------------------------------

export {
  PathaoClient,
  PATHAO_LIVE_BASE_URL,
  PATHAO_SANDBOX_BASE_URL,
  type CreateStoreInput,
  type PathaoConfig,
  type PathaoCreateOrderInput,
  type PathaoLocation,
  type PathaoLocationQuery,
  type PathaoPriceQuery,
} from './pathao/client.js'
export {
  needsAttention as pathaoNeedsAttention,
  toDeliveryStatus as toPathaoDeliveryStatus,
} from './pathao/status.js'
export {
  DELIVERY_TYPE,
  ITEM_TYPE,
  type PathaoArea,
  type PathaoCity,
  type PathaoCreateOrderData,
  type PathaoDeliveryType,
  type PathaoEnvelope,
  type PathaoItemType,
  type PathaoOrderInfoData,
  type PathaoOrderStatus,
  type PathaoPage,
  type PathaoPriceData,
  type PathaoStore,
  type PathaoTokenResponse,
  type PathaoZone,
} from './pathao/types.js'

// --- RedX ---------------------------------------------------------------------

export {
  RedxClient,
  REDX_LIVE_BASE_URL,
  REDX_SANDBOX_BASE_URL,
  type RedxConfig,
  type RedxCreateOrderInput,
} from './redx/client.js'
export {
  needsAttention as redxNeedsAttention,
  toDeliveryStatus as toRedxDeliveryStatus,
} from './redx/status.js'
export type {
  RedxArea,
  RedxAreasResponse,
  RedxCreateParcelResponse,
  RedxParcelInfo,
  RedxParcelInfoResponse,
  RedxParcelItem,
  RedxParcelStatus,
  RedxPickupStore,
  RedxPickupStoreResponse,
  RedxPickupStoresResponse,
  RedxTrackingEvent,
  RedxTrackingResponse,
} from './redx/types.js'
