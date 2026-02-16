// ── Mantle Arbitrage Monitor (Block-Polling) ────────────
// Merchant Moe (Liquidity Book) ↔ Agni Finance (V3 CLMM)
// Polls every block via HTTP — no WebSocket needed
// Paper-trade logging — no execution

require("dotenv").config()
require("./helpers/server")

const Big = require("big.js")
const ethers = require("ethers")
const config = require("./config.json")
const { getTokenAndContract, getPoolContract, calculatePrice, getPoolLiquidity } = require("./helpers/helpers")
const { provider, merchantmoe, agni } = require("./helpers/initialization")
const { logOpportunity, recordStat, printStats } = require("./helpers/logger")

// ── Config-driven constants ─────────────────────────────
const UNITS = config.PROJECT_SETTINGS.PRICE_UNITS
const PRICE_DIFFERENCE = config.PROJECT_SETTINGS.PRICE_DIFFERENCE

const MAX_SPREAD_PCT = config.THRESHOLDS.MAX_SPREAD_PCT
const MIN_SPREAD_LOG = config.THRESHOLDS.MIN_SPREAD_LOG
const TRADE_SIZE_USD = config.THRESHOLDS.TRADE_SIZE_USD

const GAS_COST_USD = config.SAFETY.GAS_COST_USD

const STATS_INTERVAL = config.OBSERVABILITY.STATS_INTERVAL_MS
const POLL_INTERVAL_MS = config.OBSERVABILITY.POLL_INTERVAL_MS || 5000

// ── State ───────────────────────────────────────────────
let lastBlock = 0
let isChecking = false
const pairState = [] // populated in main()

// ── MAIN ────────────────────────────────────────────────

const main = async () => {
  console.log(`🚀 Mantle Arbitrage Monitor (Block Polling)`)
  console.log(`   Merchant Moe LB ↔ Agni Finance V3`)
  console.log(`   Chain: ${config.PROJECT_SETTINGS.CHAIN} (${config.PROJECT_SETTINGS.CHAIN_ID})`)
  console.log(`   Mode: HTTP polling every ${POLL_INTERVAL_MS / 1000}s\n`)

  // Setup all pairs (with delay to avoid RPC burst rate-limit)
  const SETUP_DELAY_MS = 1500
  for (const pair of config.PAIRS) {
    if (pair.mode !== "ARB") continue

    try {
      console.log(`Setting up ${pair.name} [${pair.tier}]`)

      const { token0, token1 } = await getTokenAndContract(
        pair.ARB_FOR,
        pair.ARB_AGAINST,
        provider
      )

      const mmPool = await getPoolContract(merchantmoe, token0.address, token1.address, pair.MM_BIN_STEP, provider)
      const agniPool = await getPoolContract(agni, token0.address, token1.address, pair.AGNI_FEE, provider)

      console.log(`  ✅ Merchant Moe: ${await mmPool.getAddress()}`)
      console.log(`  ✅ Agni Finance: ${await agniPool.getAddress()}\n`)

      pairState.push({ pair, token0, token1, mmPool, agniPool })

    } catch (err) {
      recordStat("errors")
      console.log(`❌ Failed ${pair.name}: ${err.message}\n`)
    }

    // Throttle between pairs to stay under RPC rate limit
    await new Promise(r => setTimeout(r, SETUP_DELAY_MS))
  }

  if (pairState.length === 0) {
    console.log("⛔ No pairs initialized. Exiting.")
    process.exit(1)
  }

  console.log(`\n📊 BOT READY — ${pairState.length} pairs monitoring`)
  console.log(`⏳ Polling for new blocks...\n`)

  // Start polling loop
  setInterval(pollBlock, POLL_INTERVAL_MS)

  // Periodic stats
  setInterval(printStats, STATS_INTERVAL)
}

// ── BLOCK POLLER ────────────────────────────────────────

const pollBlock = async () => {
  if (isChecking) return

  try {
    const currentBlock = await provider.getBlockNumber()

    // Only check when block changes
    if (currentBlock <= lastBlock) return

    lastBlock = currentBlock
    isChecking = true

    // Check all pairs in parallel
    const results = await Promise.allSettled(
      pairState.map(ps => checkPair(ps, currentBlock))
    )

    // Count errors
    for (const r of results) {
      if (r.status === "rejected") {
        recordStat("errors")
      }
    }

  } catch (err) {
    // RPC call failed — not fatal, will retry next interval
    if (!err.message?.includes("could not coalesce")) {
      console.log(`⚠️ Poll error: ${err.message}`)
    }
  } finally {
    isChecking = false
  }
}

// ── CHECK SINGLE PAIR ───────────────────────────────────

const checkPair = async ({ pair, token0, token1, mmPool, agniPool }, block) => {
  recordStat("swapsDetected") // counts as "checks" in polling mode

  const mmPriceRaw = await calculatePrice(mmPool, token0, token1)
  const agniPriceRaw = await calculatePrice(agniPool, token0, token1)

  if (!mmPriceRaw || !agniPriceRaw) return

  const mmPrice = Big(mmPriceRaw.toString())
  const agniPrice = Big(agniPriceRaw.toString())

  if (mmPrice.eq(0) || agniPrice.eq(0)) return

  const priceDifference = Number(
    mmPrice.minus(agniPrice).div(agniPrice).mul(100).toFixed(6)
  )
  const absDiff = Math.abs(priceDifference)

  // Skip noise
  if (absDiff < MIN_SPREAD_LOG) return

  // Log price data
  const mmFPrice = mmPrice.toFixed(UNITS)
  const agniFPrice = agniPrice.toFixed(UNITS)

  console.log(`[${pair.name}] Block ${block} | MM: ${mmFPrice} | Agni: ${agniFPrice} | Spread: ${priceDifference.toFixed(4)}%`)

  // Sanity: ignore insane spreads
  if (absDiff > MAX_SPREAD_PCT) {
    recordStat("insaneSpreadsSkipped")
    console.log(`  ⚠️ Spread > ${MAX_SPREAD_PCT}% — data bug, skipping\n`)
    return
  }

  // Check if above arb threshold
  if (absDiff < PRICE_DIFFERENCE) return

  recordStat("spreadsAboveThreshold")

  // Determine direction
  let buyDex, sellDex
  if (priceDifference >= PRICE_DIFFERENCE) {
    buyDex = merchantmoe.name
    sellDex = agni.name
  } else {
    buyDex = agni.name
    sellDex = merchantmoe.name
  }

  // Paper profit calculation
  const grossProfitUSD = (absDiff / 100) * TRADE_SIZE_USD
  const netProfitUSD = grossProfitUSD - GAS_COST_USD

  logOpportunity({
    buyDex,
    sellDex,
    pair: `${token1.symbol}/${token0.symbol}`,
    spread: priceDifference.toFixed(4),
    block,
    tradeSizeUSD: TRADE_SIZE_USD.toFixed(0),
    grossProfitUSD: grossProfitUSD.toFixed(4),
    gasCostUSD: GAS_COST_USD.toFixed(4),
    netProfitUSD: netProfitUSD.toFixed(4),
    profitable: netProfitUSD > 0,
  })

  if (netProfitUSD > 0) {
    console.log(`  📝 Paper profit: $${netProfitUSD.toFixed(4)} | Buy ${buyDex} → Sell ${sellDex}`)
  }
}

// ── START ───────────────────────────────────────────────
main()
