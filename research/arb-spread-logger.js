/**
 * arb-spread-logger.js
 * 
 * 7-DAY EXECUTABLE SPREAD LOGGER — Arbitrum
 * 
 * WHAT THIS DOES DIFFERENTLY FROM MANTLE:
 *   - Calls quoteExactInputSingle (NOT slot0/mid-price)
 *   - Uses real notional ($1000 default)
 *   - Includes price impact in the quote
 *   - Calculates actual round-trip profit after fees
 *   - Tracks block-to-block persistence of spikes
 * 
 * If a 0.5% spread shows up here, it's REAL and EXECUTABLE.
 * 
 * Usage:
 *   node arb-spread-logger.js                         # all 5 pairs, $1000 notional
 *   node arb-spread-logger.js --notional 500          # smaller size
 *   node arb-spread-logger.js --pair WETH/PENDLE      # single pair
 *   node arb-spread-logger.js --interval 30           # poll every 30s (default 60s)
 */

require("dotenv").config()
const ethers = require("ethers")
const fs = require("fs")
const path = require("path")

// ── CLI ──
const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const NOTIONAL_USD = parseInt(getArg("notional", "1000"))
const PAIR_FILTER = getArg("pair", "all")
const POLL_INTERVAL = parseInt(getArg("interval", "60")) * 1000
const GAS_COST_USD = 0.05  // Arbitrum gas is cheap

// ── RPC ──
const RPC = process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc"

// ── TOKENS ──
const TOKENS = {
  WETH:   { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, priceUSD: 0 }, // fetched live
  USDC:   { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6,  priceUSD: 1 },
  PENDLE: { address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", decimals: 18, priceUSD: 0 },
  GNS:    { address: "0x18c11FD286C5EC11c3b683Caa813B77f5163A122", decimals: 18, priceUSD: 0 },
  MAGIC:  { address: "0x539bdE0d7Dbd336b79148AA742883198BBF60342", decimals: 18, priceUSD: 0 },
  LINK:   { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, priceUSD: 0 },
  ARB:    { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, priceUSD: 0 },
}

// ── DEX QUOTERS ──
// Uniswap V3 QuoterV2 (standard interface)
const UNI_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"
// PancakeSwap V3 QuoterV2 
const CAKE_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"
// Camelot (Algebra) Quoter — OFFICIAL from docs.algebra.finance
// Flat args: (address,address,uint256,uint160), returns (uint256,uint16)
const CAMELOT_QUOTER = "0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E"

// ── ABIs ──
const V3_QUOTER_ABI = [{
  inputs: [{ components: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "fee", type: "uint24" },
    { name: "sqrtPriceLimitX96", type: "uint160" }
  ], type: "tuple" }],
  name: "quoteExactInputSingle",
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" },
    { name: "gasEstimate", type: "uint256" }
  ],
  stateMutability: "nonpayable",
  type: "function"
}]

// Algebra quoter — struct-based (Algebra Integral / V2)
const ALGEBRA_QUOTER_ABI_V2 = [{
  inputs: [{ components: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" }
  ], name: "params", type: "tuple" }],
  name: "quoteExactInputSingle",
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "fee", type: "uint16" },
    { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" },
    { name: "gasEstimate", type: "uint256" }
  ],
  stateMutability: "nonpayable",
  type: "function"
}]

// Algebra quoter — flat args (Camelot official quoter)
// Selector: 0x2d9ebd1d
// Returns: (uint256 amountOut, uint16 fee)
const ALGEBRA_QUOTER_ABI_V1 = [{
  inputs: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "limitSqrtPrice", type: "uint160" }
  ],
  name: "quoteExactInputSingle",
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "fee", type: "uint16" }
  ],
  stateMutability: "nonpayable",
  type: "function"
}]

let algebraAbiVersion = null  // detected at startup

// For fetching WETH price
const V3_POOL_ABI = [{ inputs: [], name: "slot0", outputs: [
  { name: "sqrtPriceX96", type: "uint160" }, { type: "int24" }, { type: "uint16" },
  { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }
], stateMutability: "view", type: "function" }]

// ── PAIR CONFIGS ──
// Each pair defines which DEX venues to compare, with quoter details
const PAIRS = [
  {
    name: "WETH/PENDLE",
    token0: "WETH", token1: "PENDLE",
    venues: [
      { name: "Uniswap", quoter: UNI_QUOTER, abi: "v3", fee: 3000 },
      { name: "Camelot", quoter: CAMELOT_QUOTER, abi: "algebra" },
      { name: "Pancake", quoter: CAKE_QUOTER, abi: "v3", fee: 500 },
    ]
  },
  {
    name: "WETH/GNS",
    token0: "WETH", token1: "GNS",
    venues: [
      { name: "Uniswap", quoter: UNI_QUOTER, abi: "v3", fee: 3000 },
      { name: "Camelot", quoter: CAMELOT_QUOTER, abi: "algebra" },
    ]
  },
  {
    name: "WETH/MAGIC",
    token0: "WETH", token1: "MAGIC",
    venues: [
      { name: "Uniswap", quoter: UNI_QUOTER, abi: "v3", fee: 3000 },
      { name: "Camelot", quoter: CAMELOT_QUOTER, abi: "algebra" },
    ]
  },
  {
    name: "WETH/LINK",
    token0: "WETH", token1: "LINK",
    venues: [
      { name: "Uniswap", quoter: UNI_QUOTER, abi: "v3", fee: 3000 },
      { name: "Camelot", quoter: CAMELOT_QUOTER, abi: "algebra" },
      { name: "Pancake", quoter: CAKE_QUOTER, abi: "v3", fee: 500 },
    ]
  },
  {
    name: "USDC/ARB",
    token0: "USDC", token1: "ARB",
    venues: [
      { name: "Uniswap", quoter: UNI_QUOTER, abi: "v3", fee: 3000 },
      { name: "Camelot", quoter: CAMELOT_QUOTER, abi: "algebra" },
      { name: "Pancake", quoter: CAKE_QUOTER, abi: "v3", fee: 500 },
    ]
  }
]

// ── GLOBALS ──
let provider
const spikeTracker = {}  // { pairName_direction: { startBlock, count, maxSpread } }
const stats = {}         // { pairName: { checks, spikes05, spikes1, bestSpread, persistent2 } }

// ── QUOTER FUNCTIONS ──
async function quoteV3(quoterAddr, tokenIn, tokenOut, amountIn, fee) {
  const quoter = new ethers.Contract(quoterAddr, V3_QUOTER_ABI, provider)
  const params = {
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0n
  }
  const result = await quoter.quoteExactInputSingle.staticCall(params)
  return result[0]  // amountOut
}

async function quoteAlgebra(quoterAddr, tokenIn, tokenOut, amountIn) {
  // Try V2 (struct) first, then V1 (flat args), cache which works
  if (algebraAbiVersion === "v1" || algebraAbiVersion === null) {
    try {
      const quoter = new ethers.Contract(quoterAddr, ALGEBRA_QUOTER_ABI_V1, provider)
      const result = await quoter.quoteExactInputSingle.staticCall(
        tokenIn.address, tokenOut.address, amountIn, 0n
      )
      if (algebraAbiVersion === null) {
        algebraAbiVersion = "v1"
        console.log(`    → Camelot Algebra ABI: V1 (flat args)`)
      }
      return result[0]
    } catch (e) {
      if (algebraAbiVersion === "v1") throw e  // known v1, real error
    }
  }

  if (algebraAbiVersion === "v2" || algebraAbiVersion === null) {
    try {
      const quoter = new ethers.Contract(quoterAddr, ALGEBRA_QUOTER_ABI_V2, provider)
      const params = {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn,
        sqrtPriceLimitX96: 0n
      }
      const result = await quoter.quoteExactInputSingle.staticCall(params)
      if (algebraAbiVersion === null) {
        algebraAbiVersion = "v2"
        console.log(`    → Camelot Algebra ABI: V2 (struct)`)
      }
      return result[0]
    } catch (e) {
      if (algebraAbiVersion === "v2") throw e  // known v2, real error
      throw e  // both failed
    }
  }
}

async function getQuote(venue, tokenIn, tokenOut, amountIn) {
  if (venue.abi === "v3") {
    return await quoteV3(venue.quoter, tokenIn, tokenOut, amountIn, venue.fee)
  } else if (venue.abi === "algebra") {
    return await quoteAlgebra(venue.quoter, tokenIn, tokenOut, amountIn)
  }
  throw new Error(`Unknown ABI type: ${venue.abi}`)
}

// ── PRICE FETCHING ──
async function fetchTokenPrices() {
  // Use Uniswap WETH/USDC pool to get WETH price
  const WETH_USDC_POOL = "0xC6962004f452bE9203591991D15f6b388e09E8D0" // Uni V3 0.05%
  const pool = new ethers.Contract(WETH_USDC_POOL, V3_POOL_ABI, provider)
  
  try {
    const [sqrtPriceX96] = await pool.slot0()
    // USDC is token0 (lower address), WETH is token1
    // price = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
    // = (sqrtPriceX96 / 2^96)^2 * 10^(6-18) = gives USDC per WETH... but inverted
    const price = Number(sqrtPriceX96) ** 2 / (2 ** 192) * (10 ** (6 - 18))
    // Actually, let's use the right formula: if USDC < WETH by address sort,
    // then sqrtPriceX96 gives sqrt(WETH/USDC) in Q96... 
    // Simpler: just use a quoter call
    const quoter = new ethers.Contract(UNI_QUOTER, V3_QUOTER_ABI, provider)
    const oneWETH = ethers.parseUnits("1", 18)
    const usdcOut = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: TOKENS.WETH.address,
      tokenOut: TOKENS.USDC.address,
      amountIn: oneWETH,
      fee: 500,
      sqrtPriceLimitX96: 0n
    })
    TOKENS.WETH.priceUSD = Number(ethers.formatUnits(usdcOut[0], 6))
    console.log(`  WETH price: $${TOKENS.WETH.priceUSD.toFixed(2)}`)
  } catch (e) {
    TOKENS.WETH.priceUSD = 2700
    console.log(`  WETH price: $${TOKENS.WETH.priceUSD} (fallback)`)
  }

  // Fetch other token prices via WETH pairs on Uniswap
  for (const [sym, tok] of Object.entries(TOKENS)) {
    if (sym === "WETH" || sym === "USDC") continue
    try {
      const quoter = new ethers.Contract(UNI_QUOTER, V3_QUOTER_ABI, provider)
      const oneToken = ethers.parseUnits("1", tok.decimals)
      // Quote 1 token → WETH
      let wethOut
      try {
        wethOut = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: tok.address, tokenOut: TOKENS.WETH.address,
          amountIn: oneToken, fee: 3000, sqrtPriceLimitX96: 0n
        })
      } catch {
        wethOut = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: tok.address, tokenOut: TOKENS.WETH.address,
          amountIn: oneToken, fee: 10000, sqrtPriceLimitX96: 0n
        })
      }
      const wethAmount = Number(ethers.formatUnits(wethOut[0], 18))
      tok.priceUSD = wethAmount * TOKENS.WETH.priceUSD
      console.log(`  ${sym} price: $${tok.priceUSD.toFixed(4)}`)
    } catch (e) {
      console.log(`  ${sym} price: FAILED (${e.message.slice(0, 40)})`)
    }
    await sleep(300)
  }
}

// ── ROUND-TRIP CALCULATION ──
// For each pair of venues (A, B), calculate:
//   1. Swap notional of token0 → token1 on venue A
//   2. Swap all token1 → token0 on venue B
//   3. Profit = token0_out - token0_in
async function calculateRoundTrips(pair) {
  const t0 = TOKENS[pair.token0]
  const t1 = TOKENS[pair.token1]
  
  if (!t0.priceUSD || t0.priceUSD <= 0) return []

  const amountIn0 = ethers.parseUnits(
    (NOTIONAL_USD / t0.priceUSD).toFixed(t0.decimals > 8 ? 8 : t0.decimals),
    t0.decimals
  )

  const results = []

  // Get quotes from all venues: token0 → token1
  const forwardQuotes = []
  for (const v of pair.venues) {
    try {
      const out = await getQuote(v, t0, t1, amountIn0)
      forwardQuotes.push({ venue: v, amountOut: out })
    } catch (e) {
      forwardQuotes.push({ venue: v, amountOut: null, error: e.message.slice(0, 50) })
    }
    await sleep(100)
  }

  // For each pair of venues, calculate round trip
  for (let i = 0; i < forwardQuotes.length; i++) {
    for (let j = 0; j < forwardQuotes.length; j++) {
      if (i === j) continue
      const buyVenue = forwardQuotes[i]
      const sellVenue = pair.venues[j]

      if (!buyVenue.amountOut) continue

      try {
        // Swap back: token1 → token0 on venue j
        const amountBack = await getQuote(sellVenue, t1, t0, buyVenue.amountOut)
        
        const inUSD = Number(ethers.formatUnits(amountIn0, t0.decimals)) * t0.priceUSD
        const outUSD = Number(ethers.formatUnits(amountBack, t0.decimals)) * t0.priceUSD
        const netUSD = outUSD - inUSD - GAS_COST_USD
        const spreadPct = ((outUSD - inUSD) / inUSD * 100)
        const netPct = (netUSD / inUSD * 100)

        results.push({
          direction: `${buyVenue.venue.name}→${sellVenue.name}`,
          amountIn: Number(ethers.formatUnits(amountIn0, t0.decimals)),
          amountOut: Number(ethers.formatUnits(amountBack, t0.decimals)),
          inUSD, outUSD, netUSD,
          spreadPct: spreadPct.toFixed(4),
          netPct: netPct.toFixed(4),
        })
      } catch (e) {
        // Venue can't handle this direction
      }
      await sleep(100)
    }
  }

  return results
}

// ── PERSISTENCE TRACKING ──
function trackPersistence(pairName, direction, spreadPct, block) {
  const key = `${pairName}_${direction}`
  const spread = parseFloat(spreadPct)  // Keep sign! Only positive = opportunity

  if (spread >= 0.5) {  // POSITIVE spread only
    if (!spikeTracker[key]) {
      spikeTracker[key] = { startBlock: block, count: 1, maxSpread: spread }
    } else {
      spikeTracker[key].count++
      spikeTracker[key].maxSpread = Math.max(spikeTracker[key].maxSpread, spread)
    }
  } else {
    // Spike ended
    if (spikeTracker[key] && spikeTracker[key].count >= 1) {
      const dur = spikeTracker[key].count
      const max = spikeTracker[key].maxSpread
      if (dur >= 2) {
        console.log(`  🔥 PERSISTENT SPIKE: ${pairName} ${direction} — ${dur} blocks, max ${max.toFixed(3)}%`)
        if (!stats[pairName]) initStats(pairName)
        stats[pairName].persistent2++
      }
    }
    delete spikeTracker[key]
  }
}

function initStats(name) {
  stats[name] = { checks: 0, spikes05: 0, spikes1: 0, bestSpread: 0, persistent2: 0, totalNetPct: 0 }
}

// ── MAIN LOOP ──
async function main() {
  provider = new ethers.JsonRpcProvider(RPC)

  console.log("═══════════════════════════════════════════════════")
  console.log("  Arbitrum Executable Spread Logger")
  console.log("  REAL quoter calls, not mid-prices.")
  console.log("═══════════════════════════════════════════════════")
  console.log(`  RPC: ${RPC}`)
  console.log(`  Notional: $${NOTIONAL_USD}`)
  console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`)
  console.log(`  Gas estimate: $${GAS_COST_USD}`)
  console.log()

  // Verify RPC
  const block = await provider.getBlockNumber()
  console.log(`  ✅ Connected (block ${block})`)

  // Fetch token prices
  console.log(`\n  Fetching token prices...`)
  await fetchTokenPrices()

  // Filter pairs
  const activePairs = PAIR_FILTER === "all"
    ? PAIRS
    : PAIRS.filter(p => p.name === PAIR_FILTER)

  if (activePairs.length === 0) {
    console.log(`  ❌ No pairs match filter: ${PAIR_FILTER}`)
    process.exit(1)
  }

  // Self-test: try one quote per venue to verify quoter addresses
  console.log(`\n  Quoter self-test...`)
  for (const pair of activePairs) {
    const t0 = TOKENS[pair.token0]
    const t1 = TOKENS[pair.token1]
    if (!t0.priceUSD || t0.priceUSD <= 0) {
      console.log(`  ⚠️ ${pair.name}: ${pair.token0} has no price, skipping`)
      continue
    }
    const testAmt = ethers.parseUnits(
      (100 / t0.priceUSD).toFixed(t0.decimals > 8 ? 8 : t0.decimals),
      t0.decimals
    )
    for (const v of pair.venues) {
      try {
        await getQuote(v, t0, t1, testAmt)
        console.log(`    ✅ ${pair.name} on ${v.name}: quoter works`)
      } catch (e) {
        console.log(`    ❌ ${pair.name} on ${v.name}: FAILED — ${e.message.slice(0, 60)}`)
        console.log(`       Quoter: ${v.quoter}`)
      }
      await sleep(200)
    }
  }

  // Init stats
  for (const p of activePairs) initStats(p.name)

  // Setup output file
  const outDir = path.join(__dirname, "arb_spread_logs")
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const startDate = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const outFile = path.join(outDir, `spreads_${startDate}_${NOTIONAL_USD}usd.jsonl`)
  
  console.log(`\n  Output: ${outFile}`)
  console.log(`\n  Starting spread monitoring...`)
  console.log(`  Press Ctrl+C to stop.\n`)

  // Poll loop
  let cycle = 0
  const startTime = Date.now()

  const poll = async () => {
    try {
      const currentBlock = await provider.getBlockNumber()
      cycle++

      for (const pair of activePairs) {
        try {
          const trips = await calculateRoundTrips(pair)
          
          for (const trip of trips) {
            const spread = Math.abs(parseFloat(trip.spreadPct))
            const net = parseFloat(trip.netPct)

            // Update stats
            const rawSpreadForStats = parseFloat(trip.spreadPct)
            stats[pair.name].checks++
            stats[pair.name].totalNetPct += net
            if (rawSpreadForStats > stats[pair.name].bestSpread) stats[pair.name].bestSpread = rawSpreadForStats
            if (rawSpreadForStats >= 0.5) stats[pair.name].spikes05++
            if (rawSpreadForStats >= 1.0) stats[pair.name].spikes1++

            // Track persistence
            trackPersistence(pair.name, trip.direction, trip.spreadPct, currentBlock)

            // Log to file
            const record = {
              timestamp: new Date().toISOString(),
              block: currentBlock,
              pair: pair.name,
              direction: trip.direction,
              notionalUSD: NOTIONAL_USD,
              spreadPct: trip.spreadPct,
              netPct: trip.netPct,
              netUSD: trip.netUSD.toFixed(4),
              inUSD: trip.inUSD.toFixed(2),
              outUSD: trip.outUSD.toFixed(2),
            }
            fs.appendFileSync(outFile, JSON.stringify(record) + "\n")

            // Console output for notable spreads
            // ONLY flag POSITIVE spreads (actual profit opportunities)
            const rawSpread = parseFloat(trip.spreadPct)
            if (rawSpread >= 0.3) {
              const emoji = rawSpread >= 1.0 ? "🔥🔥" : rawSpread >= 0.5 ? "🔥" : "📊"
              console.log(`  ${emoji} ${pair.name} ${trip.direction}: spread=+${trip.spreadPct}% net=${trip.netPct}% ($${trip.netUSD.toFixed(2)}) [block ${currentBlock}]`)
            } else if (rawSpread <= -0.3 && cycle <= 3) {
              // Only show losses in first few cycles for diagnostics
              console.log(`  💀 ${pair.name} ${trip.direction}: spread=${trip.spreadPct}% (LOSS) [block ${currentBlock}]`)
            }
          }
        } catch (e) {
          // Pair-level error, don't kill the loop
          if (cycle <= 2) console.log(`  ⚠️ ${pair.name}: ${e.message.slice(0, 60)}`)
        }
      }

      // Periodic summary (every 10 cycles)
      if (cycle % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 3600000).toFixed(1)
        console.log(`\n  ── Summary (${elapsed}h, cycle ${cycle}) ──`)
        for (const [name, s] of Object.entries(stats)) {
          if (s.checks === 0) continue
          const avgNet = (s.totalNetPct / s.checks).toFixed(3)
          console.log(`  ${name}: ${s.checks} checks | best=${s.bestSpread.toFixed(3)}% | ≥0.5%: ${s.spikes05} | ≥1%: ${s.spikes1} | persistent(≥2blk): ${s.persistent2} | avgNet=${avgNet}%`)
        }
        console.log()

        // Refresh token prices every 10 cycles
        await fetchTokenPrices().catch(() => {})
      }

    } catch (e) {
      console.log(`  ⚠️ Poll error: ${e.message.slice(0, 60)}`)
    }
  }

  // Initial poll
  await poll()

  // Set interval
  setInterval(poll, POLL_INTERVAL)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n  ════════════════════════════════════")
  console.log("  FINAL STATS")
  console.log("  ════════════════════════════════════")
  for (const [name, s] of Object.entries(stats)) {
    if (s.checks === 0) continue
    const avgNet = (s.totalNetPct / s.checks).toFixed(3)
    console.log(`  ${name}:`)
    console.log(`    Checks: ${s.checks}`)
    console.log(`    Best spread: ${s.bestSpread.toFixed(3)}%`)
    console.log(`    Spikes ≥0.5%: ${s.spikes05}`)
    console.log(`    Spikes ≥1.0%: ${s.spikes1}`)
    console.log(`    Persistent ≥2 blocks: ${s.persistent2}`)
    console.log(`    Avg net: ${avgNet}%`)
  }
  console.log()
  process.exit(0)
})

main().catch(e => { console.error(e); process.exit(1) })
