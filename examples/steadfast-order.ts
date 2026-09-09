/**
 * Ship a COD order and poll it to settlement.
 *
 * Run with real credentials:
 *   STEADFAST_API_KEY=... STEADFAST_SECRET_KEY=... npx tsx examples/steadfast-order.ts
 *
 * Imports are relative so the example typechecks inside this repo. In your own
 * project it is `import { SteadfastClient } from 'bd-commerce/steadfast'`.
 */
import { SteadfastClient } from '../src/steadfast/index.js'
import { BdCommerceError } from '../src/core/errors.js'

const steadfast = new SteadfastClient({
  apiKey: process.env.STEADFAST_API_KEY ?? '',
  secretKey: process.env.STEADFAST_SECRET_KEY ?? '',
})

async function main() {
  const balance = await steadfast.getBalance()
  console.log(`Merchant balance: BDT ${balance.currentBalance}`)

  const order = await steadfast.createOrder({
    invoice: `DEMO-${Date.now()}`,
    recipientName: 'Rahim Uddin',
    recipientPhone: '+8801712345678',
    recipientAddress: 'House 4, Road 11, Banani, Dhaka 1213',
    codAmount: 1250,
    note: 'Call before delivery',
  })

  console.log(`Consignment ${order.consignmentId}, tracking ${order.trackingCode}`)

  const status = await steadfast.getStatusByConsignmentId(order.consignmentId)

  // The distinction that matters: `delivered` here is settled. An unsettled
  // report arrives as `in_review` with `pendingApproval` set, and must not be
  // used to release stock or close the order.
  if (status.status === 'delivered') {
    console.log('Settled as delivered')
  } else if (status.pendingApproval) {
    console.log(`Reported ${status.providerStatus}, awaiting courier approval`)
  } else {
    console.log(`Currently ${status.status}`)
  }
}

main().catch((error: unknown) => {
  if (BdCommerceError.is(error)) {
    console.error(`[${error.provider}] ${error.code}: ${error.message}`)
    console.error('Raw response:', error.response)
    process.exit(1)
  }
  throw error
})
