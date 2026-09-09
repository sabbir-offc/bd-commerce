/**
 * Loads the built package the way a consumer would and exercises enough of it
 * to prove the artifact works on this Node version.
 *
 * Plain .mjs on purpose: this runs on the oldest Node in `engines`, with no
 * pnpm, no tsx and no devDependencies. The build toolchain needs Node 22.13+,
 * but the thing we publish must work on 18.17, and only this check proves it.
 *
 *   node scripts/ci/import-check.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const esm = await import(new URL('../../dist/index.js', import.meta.url))
const cjs = require('../../dist/index.cjs')

// Subpath exports, resolved by name. This is what catches a broken `exports`
// map, which a relative import would happily sail past.
const steadfast = await import('bd-commerce/steadfast')
const bkash = await import('bd-commerce/bkash')

for (const [label, mod] of [
  ['esm', esm],
  ['cjs', cjs],
]) {
  assert.equal(typeof mod.SteadfastClient, 'function', `${label}: SteadfastClient missing`)
  assert.equal(typeof mod.BkashClient, 'function', `${label}: BkashClient missing`)
  assert.equal(typeof mod.normalizeBdPhone, 'function', `${label}: normalizeBdPhone missing`)

  assert.equal(mod.normalizeBdPhone('+880 1712-345678'), '01712345678', `${label}: phone`)
  assert.equal(mod.isBdPhone('01212345678'), false, `${label}: retired prefix accepted`)
}

assert.equal(typeof steadfast.SteadfastClient, 'function', 'subpath: bd-commerce/steadfast')
assert.equal(typeof bkash.BkashClient, 'function', 'subpath: bd-commerce/bkash')
assert.equal(steadfast.toDeliveryStatus('delivered_approval_pending'), 'in_review')

// Construction and local validation, with no network in sight.
assert.throws(() => new esm.SteadfastClient({ apiKey: '', secretKey: 'x' }), esm.ConfigError)

const client = new esm.SteadfastClient({ apiKey: 'k', secretKey: 's' })
await assert.rejects(
  () =>
    client.createOrder({
      invoice: '',
      recipientName: 'a',
      recipientPhone: '01712345678',
      recipientAddress: 'b',
      codAmount: 0,
    }),
  esm.ValidationError,
)

const callback = esm.BkashClient.parseCallback('https://x.test/cb?paymentID=TR1&status=success')
assert.deepEqual(
  { id: callback.paymentId, status: callback.status },
  { id: 'TR1', status: 'success' },
)

console.log(`ok — dist loads and behaves on Node ${process.version} (esm, cjs, subpaths)`)
