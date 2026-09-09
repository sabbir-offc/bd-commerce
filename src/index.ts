/**
 * bd-commerce — typed clients for Bangladeshi courier and payment providers.
 *
 * Import the root for everything, or a subpath to keep bundles small:
 *
 * ```ts
 * import { SteadfastClient } from 'bd-commerce/steadfast'
 * import { BkashClient } from 'bd-commerce/bkash'
 * ```
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

export type {
  BulkOrderResult,
  Courier,
  CourierBalance,
  CourierOrder,
  CourierStatus,
  CreateOrderInput,
  DeliveryStatus,
} from './courier/types.js'

export * from './steadfast/index.js'
export * from './bkash/index.js'
