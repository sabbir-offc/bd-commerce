/**
 * bKash token handling now lives in `src/core/token.ts`, shared with Pathao.
 * These aliases keep the `bd-commerce/bkash` surface readable in bKash's own
 * vocabulary — its docs call the access token an id token.
 */
export {
  EXPIRY_SKEW_MS,
  MemoryTokenStore,
  TokenManager,
  type AccessToken as BkashToken,
  type TokenManagerOptions,
  type TokenStore as BkashTokenStore,
} from '../core/token.js'
