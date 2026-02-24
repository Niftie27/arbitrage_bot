/**
 * spread-logger.js — Chain-Agnostic Executable Spread Logger
 * 
 * Part of the Chain Testing Playbook.
 * Tests structural arbitrage across DEXes with DIFFERENT AMM models.
 * All quotes are executable (quoter-based), not mid-price.
 * 
 * Usage:
 *   node spread-logger.js --chain avalanche
 *   node spread-logger.js --chain avalanche --notional 300
 *   node spread-logger.js --chain avalanche --pair WAVAX/USDCe
 *   node spread-logger.js --chain avalanche --interval 30
 *   node spread-logger.js --chain avalanche --notional 100,300,1000
 */

require("dotenv").config()
const ethers = require("ethers")
const fs = require("fs")
const path = require("path")

// ══════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════
const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const CHAIN_NAME = getArg("chain", null)
if (!CHAIN_NAME) {
  console.error("Usage: node spread-logger.js --chain <chain_name>")
  console.error("Available chains: check chains/ directory")
  process.exit(1)
}

const NOTIONALS = getArg("notional", "100,300,1000").split(",").map(Number)
const PAIR_FILTER = getArg("pair", "all")
const POLL_INTERVAL = parseInt(getArg("interval", "60")) * 1000

// ══════════════════════════════════════════════════
// LOAD CHAIN CONFIG
// ══════════════════════════════════════════════════
const configPath = path.join(__dirname, "chains", `${CHAIN_NAME}.json`)
if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`)
  console.error(`Create chains/${CHAIN_NAME}.json first.`)
  process.exit(1)
}
const CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"))
const TOKENS = {}
for (const [sym, info] of Object.entries(CONFIG.tokens)) {
  TOKENS[sym] = { ...info, symbol: sym }
}
const GAS_COST_USD = CONFIG.gasCostUSD || 0.10

// ══════════════════════════════════════════════════
// ABIs
// ══════════════════════════════════════════════════

// Uniswap V3 QuoterV2
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
  stateMutability: "nonpayable", type: "function"
}]

// Algebra V1 (flat args — Camelot style)
const ALGEBRA_V1_ABI = [{
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
  stateMutability: "nonpayable", type: "function"
}]

// Algebra V2 (struct — Algebra Integral)
const ALGEBRA_V2_ABI = [{
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
  stateMutability: "nonpayable", type: "function"
}]

// Uniswap V2 / Pangolin Router — getAmountsOut
const V2_ROUTER_ABI = [{
  inputs: [
    { name: "amountIn", type: "uint256" },
    { name: "path", type: "address[]" }
  ],
  name: "getAmountsOut",
  outputs: [{ name: "amounts", type: "uint256[]" }],
  stateMutability: "view", type: "function"
}]

// Trader Joe LB Quoter V2.2 — findBestPathFromAmountIn
// CRITICAL: amountIn is uint128 (not uint256) in V2.2
const LB_QUOTER_ABI = [{
  inputs: [
    { name: "route", type: "address[]" },
    { name: "amountIn", type: "uint128" }
  ],
  name: "findBestPathFromAmountIn",
  outputs: [{
    components: [
      { name: "route", type: "address[]" },
      { name: "pairs", type: "address[]" },
      { name: "binSteps", type: "uint256[]" },
      { name: "versions", type: "uint8[]" },
      { name: "amounts", type: "uint128[]" },
      { name: "virtualAmountsWithoutSlippage", type: "uint128[]" },
      { name: "fees", type: "uint128[]" }
    ],
    type: "tuple"
  }],
  stateMutability: "view", type: "function"
}]

// ══════════════════════════════════════════════════
// GLOBALS
// ══════════════════════════════════════════════════
let provider
let algebraAbiVersion = null
const spikeTracker = {}
const stats = {}

// ══════════════════════════════════════════════════
// QUOTER FUNCTIONS
// ══════════════════════════════════════════════════
async function quoteV3(dexConfig, tokenIn, tokenOut, amountIn, fee) {
  const quoter = new ethers.Contract(dexConfig.quoter, V3_QUOTER_ABI, provider)
  const result = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn, fee,
    sqrtPriceLimitX96: 0n
  })
  return result[0]
}

async function quoteAlgebra(dexConfig, tokenIn, tokenOut, amountIn) {
  if (algebraAbiVersion === "v1" || algebraAbiVersion === null) {
    try {
      const q = new ethers.Contract(dexConfig.quoter, ALGEBRA_V1_ABI, provider)
      const r = await q.quoteExactInputSingle.staticCall(tokenIn.address, tokenOut.address, amountIn, 0n)
      if (!algebraAbiVersion) { algebraAbiVersion = "v1"; console.log(`    → Algebra ABI: V1 (flat args)`) }
      return r[0]
    } catch (e) { if (algebraAbiVersion === "v1") throw e }
  }
  if (algebraAbiVersion === "v2" || algebraAbiVersion === null) {
    try {
      const q = new ethers.Contract(dexConfig.quoter, ALGEBRA_V2_ABI, provider)
      const r = await q.quoteExactInputSingle.staticCall({
        tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, sqrtPriceLimitX96: 0n
      })
      if (!algebraAbiVersion) { algebraAbiVersion = "v2"; console.log(`    → Algebra ABI: V2 (struct)`) }
      return r[0]
    } catch (e) { if (algebraAbiVersion === "v2") throw e; throw e }
  }
}

async function quoteV2(dexConfig, tokenIn, tokenOut, amountIn) {
  const router = new ethers.Contract(dexConfig.router, V2_ROUTER_ABI, provider)
  const amounts = await router.getAmountsOut(amountIn, [tokenIn.address, tokenOut.address])
  return amounts[1]
}

async function quoteLB(dexConfig, tokenIn, tokenOut, amountIn) {
  const quoter = new ethers.Contract(dexConfig.quoter, LB_QUOTER_ABI, provider)
  // LB V2.2 expects uint128 — truncate if larger (shouldn't be for reasonable notionals)
  const MAX_UINT128 = (1n << 128n) - 1n
  const safeAmountIn = amountIn > MAX_UINT128 ? MAX_UINT128 : amountIn
  const result = await quoter.findBestPathFromAmountIn(
    [tokenIn.address, tokenOut.address],
    safeAmountIn
  )
  // result.amounts = [amountIn, amountOut] — last element is the output
  const amounts = result.amounts || result[4]  // handle both named and positional
  const amountOut = amounts[amounts.length - 1]
  return amountOut
}

async function getQuote(venue, tokenIn, tokenOut, amountIn) {
  const dexName = venue.dex
  const dexConfig = CONFIG.dexes[dexName]
  if (!dexConfig) throw new Error(`Unknown DEX: ${dexName}`)

  switch (dexConfig.type) {
    case "v3":
      return await quoteV3(dexConfig, tokenIn, tokenOut, amountIn, venue.fee || 3000)
    case "algebra":
      return await quoteAlgebra(dexConfig, tokenIn, tokenOut, amountIn)
    case "v2":
      return await quoteV2(dexConfig, tokenIn, tokenOut, amountIn)
    case "lb":
      return await quoteLB(dexConfig, tokenIn, tokenOut, amountIn)
    default:
      throw new Error(`Unknown DEX type: ${dexConfig.type}`)
  }
}

// ══════════════════════════════════════════════════
// PRICE FETCHING
// ══════════════════════════════════════════════════
async function fetchTokenPrices() {
  const ref = CONFIG.priceReference
  const baseToken = TOKENS[ref.baseToken]
  const quoteToken = TOKENS[ref.quoteToken]

  // Fetch native token price
  try {
    const oneUnit = ethers.parseUnits("1", baseToken.decimals)
    const venue = { dex: Object.keys(CONFIG.dexes).find(d => CONFIG.dexes[d].type === ref.quoter?.replace("UNI_", "").toLowerCase()) || Object.keys(CONFIG.dexes)[0], fee: ref.fee }
    
    // Try each DEX until one works
    let price = 0
    for (const [dexName, dexConfig] of Object.entries(CONFIG.dexes)) {
      try {
        const v = { dex: dexName, fee: ref.fee || 500 }
        const out = await getQuote(v, baseToken, quoteToken, oneUnit)
        price = Number(ethers.formatUnits(out, quoteToken.decimals))
        break
      } catch {}
    }

    if (price > 0) {
      baseToken.priceUSD = price
      console.log(`  ${ref.baseToken} price: $${price.toFixed(4)}`)
    } else {
      baseToken.priceUSD = 25 // AVAX fallback
      console.log(`  ${ref.baseToken} price: $${baseToken.priceUSD} (fallback)`)
    }
  } catch (e) {
    baseToken.priceUSD = 25
    console.log(`  ${ref.baseToken} price: $${baseToken.priceUSD} (fallback)`)
  }

  // Fetch other token prices via native token pairs
  for (const [sym, tok] of Object.entries(TOKENS)) {
    if (sym === ref.baseToken || tok.priceUSD === 1) continue
    if (tok.priceUSD > 0 && sym !== ref.baseToken) continue // already set (stables)
    
    try {
      const oneToken = ethers.parseUnits("1", tok.decimals)
      let nativeOut = 0n
      for (const [dexName, dexConfig] of Object.entries(CONFIG.dexes)) {
        try {
          const v = { dex: dexName, fee: 3000 }
          nativeOut = await getQuote(v, tok, TOKENS[ref.baseToken], oneToken)
          break
        } catch {}
      }
      if (nativeOut > 0n) {
        const nativeAmount = Number(ethers.formatUnits(nativeOut, TOKENS[ref.baseToken].decimals))
        tok.priceUSD = nativeAmount * TOKENS[ref.baseToken].priceUSD
        console.log(`  ${sym} price: $${tok.priceUSD.toFixed(4)}`)
      }
    } catch {}
    await sleep(200)
  }
}

// ══════════════════════════════════════════════════
// ROUND-TRIP CALCULATION
// ══════════════════════════════════════════════════
async function calculateRoundTrips(pair, notionalUSD) {
  const t0 = TOKENS[pair.token0]
  const t1 = TOKENS[pair.token1]
  if (!t0 || !t1) return []
  if (!t0.priceUSD || t0.priceUSD <= 0) return []

  const amountIn0 = ethers.parseUnits(
    (notionalUSD / t0.priceUSD).toFixed(Math.min(t0.decimals, 8)),
    t0.decimals
  )

  const results = []

  // Get forward quotes from all venues
  const forwardQuotes = []
  for (const v of pair.venues) {
    try {
      const out = await getQuote(v, t0, t1, amountIn0)
      forwardQuotes.push({ venue: v, amountOut: out })
    } catch (e) {
      forwardQuotes.push({ venue: v, amountOut: null, error: e.message?.slice(0, 60) })
    }
    await sleep(80)
  }

  // For each pair of venues, calculate round trip
  for (let i = 0; i < forwardQuotes.length; i++) {
    for (let j = 0; j < forwardQuotes.length; j++) {
      if (i === j) continue
      const buyQ = forwardQuotes[i]
      const sellVenue = pair.venues[j]
      if (!buyQ.amountOut) continue

      try {
        const amountBack = await getQuote(sellVenue, t1, t0, buyQ.amountOut)
        const inUSD = Number(ethers.formatUnits(amountIn0, t0.decimals)) * t0.priceUSD
        const outUSD = Number(ethers.formatUnits(amountBack, t0.decimals)) * t0.priceUSD
        const netUSD = outUSD - inUSD - GAS_COST_USD
        const spreadPct = ((outUSD - inUSD) / inUSD * 100)
        const netPct = (netUSD / inUSD * 100)

        results.push({
          direction: `${buyQ.venue.dex}→${sellVenue.dex}`,
          notionalUSD,
          inUSD, outUSD, netUSD,
          spreadPct: spreadPct.toFixed(4),
          netPct: netPct.toFixed(4),
        })
      } catch {}
      await sleep(80)
    }
  }
  return results
}

// ══════════════════════════════════════════════════
// PERSISTENCE TRACKING
// ══════════════════════════════════════════════════
function trackPersistence(pairName, direction, spreadPct, block, notional) {
  const key = `${pairName}_${direction}_${notional}`
  const spread = parseFloat(spreadPct)

  if (spread >= 0.3) {
    if (!spikeTracker[key]) {
      spikeTracker[key] = { startBlock: block, count: 1, maxSpread: spread, startTime: Date.now() }
    } else {
      spikeTracker[key].count++
      spikeTracker[key].maxSpread = Math.max(spikeTracker[key].maxSpread, spread)
    }
  } else {
    if (spikeTracker[key] && spikeTracker[key].count >= 1) {
      const dur = spikeTracker[key].count
      const max = spikeTracker[key].maxSpread
      const durationSec = ((Date.now() - spikeTracker[key].startTime) / 1000).toFixed(0)
      if (dur >= 2) {
        console.log(`  🔥 PERSISTENT: ${pairName} ${direction} $${notional} — ${dur} blocks (${durationSec}s), max ${max.toFixed(3)}%`)
        const sKey = `${pairName}_${notional}`
        if (stats[sKey]) stats[sKey].persistent2++
      }
    }
    delete spikeTracker[key]
  }
}

function initStats(name, notional) {
  const key = `${name}_${notional}`
  stats[key] = { pair: name, notional, checks: 0, spikes03: 0, spikes05: 0, spikes1: 0, bestSpread: -999, persistent2: 0, totalNetPct: 0 }
}

// ══════════════════════════════════════════════════
// SUMMARY FILE WRITER
// ══════════════════════════════════════════════════
function writeSummaryFile(outDir, startTime) {
  const elapsed = ((Date.now() - startTime) / 3600000).toFixed(2)
  const summaryPath = path.join(outDir, `summary_latest.txt`)
  
  let lines = []
  lines.push(`═══════════════════════════════════════════`)
  lines.push(`${CONFIG.name} — Spread Summary`)
  lines.push(`Runtime: ${elapsed}h | Generated: ${new Date().toISOString()}`)
  lines.push(`═══════════════════════════════════════════`)
  lines.push(``)

  let anyPositive = false
  let anyPersistent = false
  let bestOverall = -999

  for (const notional of NOTIONALS) {
    lines.push(`--- $${notional} notional ---`)
    for (const [key, s] of Object.entries(stats)) {
      if (!key.endsWith(`_${notional}`) || s.checks === 0) continue
      const avgNet = (s.totalNetPct / s.checks).toFixed(3)
      lines.push(`${s.pair}: ${s.checks} chk | best=${s.bestSpread.toFixed(3)}% | ≥0.3%:${s.spikes03} ≥0.5%:${s.spikes05} ≥1%:${s.spikes1} | persist≥2blk:${s.persistent2} | avgNet=${avgNet}%`)
      if (s.bestSpread > bestOverall) bestOverall = s.bestSpread
      if (s.spikes05 > 0) anyPositive = true
      if (s.persistent2 > 0) anyPersistent = true
    }
    lines.push(``)
  }

  lines.push(`═══════════════════════════════════════════`)
  lines.push(`VERDICT:`)
  if (anyPersistent) {
    lines.push(`✅ PROMOTE — Persistent positive spreads detected`)
  } else if (anyPositive) {
    lines.push(`🟡 EXTEND — Positive spreads exist but persistence unknown`)
  } else if (bestOverall >= 0.3) {
    lines.push(`🟡 BORDERLINE — Some positive signals but below threshold`)
  } else {
    lines.push(`❌ KILL — No positive executable spreads found`)
  }
  lines.push(`Best spread seen: ${bestOverall.toFixed(3)}%`)
  lines.push(`═══════════════════════════════════════════`)

  fs.writeFileSync(summaryPath, lines.join("\n") + "\n")
  console.log(`  📝 Summary written to ${summaryPath}`)
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════
async function main() {
  const RPC = process.env[`${CHAIN_NAME.toUpperCase()}_RPC`] || CONFIG.rpcHttp
  provider = new ethers.JsonRpcProvider(RPC)

  console.log("═══════════════════════════════════════════════════════════")
  console.log(`  ${CONFIG.name} — Executable Spread Logger`)
  console.log("  Chain Testing Playbook — Kill or Promote in 24h")
  console.log("═══════════════════════════════════════════════════════════")
  console.log(`  Chain: ${CONFIG.name} (${CONFIG.chain})`)
  console.log(`  RPC: ${RPC}`)
  console.log(`  Notionals: $${NOTIONALS.join(", $")}`)
  console.log(`  Poll: ${POLL_INTERVAL / 1000}s | Gas est: $${GAS_COST_USD}`)
  console.log(`  DEXes: ${Object.entries(CONFIG.dexes).map(([n, d]) => `${n}(${d.type})`).join(", ")}`)

  const block = await provider.getBlockNumber()
  console.log(`  ✅ Connected (block ${block})`)

  // Filter pairs
  const activePairs = PAIR_FILTER === "all"
    ? CONFIG.pairs
    : CONFIG.pairs.filter(p => p.name === PAIR_FILTER)

  if (!activePairs.length) {
    console.log(`  ❌ No pairs match: ${PAIR_FILTER}`)
    process.exit(1)
  }
  console.log(`  Pairs: ${activePairs.length}`)

  // Fetch prices
  console.log(`\n  Fetching token prices...`)
  await fetchTokenPrices()

  // Self-test quoters
  console.log(`\n  Quoter self-test...`)
  for (const pair of activePairs) {
    const t0 = TOKENS[pair.token0]
    const t1 = TOKENS[pair.token1]
    if (!t0?.priceUSD || t0.priceUSD <= 0) {
      console.log(`  ⚠️ ${pair.name}: ${pair.token0} no price, skipping`)
      continue
    }
    const testAmt = ethers.parseUnits(
      (10 / t0.priceUSD).toFixed(Math.min(t0.decimals, 8)),
      t0.decimals
    )
    for (const v of pair.venues) {
      try {
        const out = await getQuote(v, t0, t1, testAmt)
        const outFmt = Number(ethers.formatUnits(out, t1.decimals)).toFixed(4)
        console.log(`    ✅ ${pair.name} on ${v.dex}: ${outFmt} ${pair.token1}`)
      } catch (e) {
        console.log(`    ❌ ${pair.name} on ${v.dex}: ${e.message?.slice(0, 70)}`)
      }
      await sleep(200)
    }
  }

  // Init stats
  for (const p of activePairs) {
    for (const n of NOTIONALS) initStats(p.name, n)
  }

  // Output files
  const outDir = path.join(__dirname, "spread_logs", CHAIN_NAME)
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const outFile = path.join(outDir, `spreads_${ts}.jsonl`)

  console.log(`\n  Output: ${outFile}`)
  console.log(`  Starting spread monitoring...\n`)

  let cycle = 0
  const startTime = Date.now()

  const poll = async () => {
    try {
      const currentBlock = await provider.getBlockNumber()
      const blockTime = new Date().toISOString()
      cycle++

      for (const pair of activePairs) {
        for (const notional of NOTIONALS) {
          try {
            const trips = await calculateRoundTrips(pair, notional)
            for (const trip of trips) {
              const spread = parseFloat(trip.spreadPct)
              const net = parseFloat(trip.netPct)
              const sKey = `${pair.name}_${notional}`

              // Stats
              if (stats[sKey]) {
                stats[sKey].checks++
                stats[sKey].totalNetPct += net
                if (spread > stats[sKey].bestSpread) stats[sKey].bestSpread = spread
                if (spread >= 0.3) stats[sKey].spikes03++
                if (spread >= 0.5) stats[sKey].spikes05++
                if (spread >= 1.0) stats[sKey].spikes1++
              }

              // Persistence
              trackPersistence(pair.name, trip.direction, trip.spreadPct, currentBlock, notional)

              // Log raw data to JSONL — ONLY log if spread > -2% (filter dead-pair noise)
              if (spread > -2.0) {
                const record = {
                  ts: blockTime, block: currentBlock, chain: CHAIN_NAME,
                  pair: pair.name, dir: trip.direction, notional,
                  spreadPct: trip.spreadPct, netPct: trip.netPct,
                  netUSD: trip.netUSD.toFixed(4),
                  inUSD: trip.inUSD.toFixed(2), outUSD: trip.outUSD.toFixed(2),
                }
                fs.appendFileSync(outFile, JSON.stringify(record) + "\n")
              }

              // Console for notable spreads
              if (spread >= 0.3) {
                const emoji = spread >= 1.0 ? "🔥🔥" : spread >= 0.5 ? "🔥" : "📊"
                console.log(`  ${emoji} ${pair.name} $${notional} ${trip.direction}: +${trip.spreadPct}% net=${trip.netPct}% ($${trip.netUSD.toFixed(2)}) [blk ${currentBlock}]`)
              }
            }
          } catch (e) {
            if (cycle <= 2) console.log(`  ⚠️ ${pair.name} $${notional}: ${e.message?.slice(0, 60)}`)
          }
        }
      }

      // Summary every 10 cycles
      if (cycle % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 3600000).toFixed(2)
        console.log(`\n  ── Summary (${elapsed}h, cycle ${cycle}, block ${currentBlock}) ──`)
        
        // Group by notional for cleaner output
        for (const notional of NOTIONALS) {
          console.log(`  --- $${notional} notional ---`)
          for (const [key, s] of Object.entries(stats)) {
            if (!key.endsWith(`_${notional}`) || s.checks === 0) continue
            const avgNet = (s.totalNetPct / s.checks).toFixed(3)
            console.log(`  ${s.pair}: ${s.checks} chk | best=${s.bestSpread.toFixed(3)}% | ≥0.3%:${s.spikes03} ≥0.5%:${s.spikes05} ≥1%:${s.spikes1} | persist≥2:${s.persistent2} | avgNet=${avgNet}%`)
          }
        }
        console.log()

        // Refresh prices
        await fetchTokenPrices().catch(() => {})
      }

      // Write summary file every 60 cycles (~1h at 60s interval)
      if (cycle % 60 === 0 || cycle === 1) {
        writeSummaryFile(outDir, startTime)
      }

      // Auto-shutdown after 24h
      if (Date.now() - startTime > 24 * 3600 * 1000) {
        console.log("\n  ⏰ 24h reached — auto-shutdown")
        writeSummaryFile(outDir, startTime)
        process.kill(process.pid, "SIGINT")
      }
    } catch (e) {
      console.log(`  ⚠️ Poll error: ${e.message?.slice(0, 80)}`)
    }
  }

  await poll()
  setInterval(poll, POLL_INTERVAL)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Graceful shutdown with full report
process.on("SIGINT", () => {
  const elapsed = ((Date.now() - Date.now()) / 3600000).toFixed(2) // approximate
  console.log("\n\n  ════════════════════════════════════════")
  console.log(`  FINAL REPORT — ${CONFIG.name}`)
  console.log("  ════════════════════════════════════════")

  // Kill/Promote decision
  let anyPositive = false
  let anyPersistent = false
  let bestOverall = -999

  for (const notional of NOTIONALS) {
    console.log(`\n  --- $${notional} notional ---`)
    for (const [key, s] of Object.entries(stats)) {
      if (!key.endsWith(`_${notional}`) || s.checks === 0) continue
      const avgNet = (s.totalNetPct / s.checks).toFixed(3)
      console.log(`  ${s.pair}:`)
      console.log(`    Checks: ${s.checks}`)
      console.log(`    Best spread: ${s.bestSpread.toFixed(3)}%`)
      console.log(`    ≥0.3%: ${s.spikes03} | ≥0.5%: ${s.spikes05} | ≥1.0%: ${s.spikes1}`)
      console.log(`    Persistent ≥2 blocks: ${s.persistent2}`)
      console.log(`    Avg net: ${avgNet}%`)
      
      if (s.bestSpread > bestOverall) bestOverall = s.bestSpread
      if (s.spikes05 > 0) anyPositive = true
      if (s.persistent2 > 0) anyPersistent = true
    }
  }

  console.log("\n  ═══════════════════════════════")
  console.log("  VERDICT:")
  if (anyPersistent) {
    console.log("  ✅ PROMOTE — Persistent positive spreads detected")
    console.log("  → Extend to 7-day test with event-driven monitoring")
  } else if (anyPositive) {
    console.log("  🟡 EXTEND — Positive spreads exist but persistence unknown")
    console.log("  → Run 7 more days to confirm")
  } else if (bestOverall >= 0.3) {
    console.log("  🟡 BORDERLINE — Some positive signals but below threshold")
    console.log("  → Consider extending or moving to next chain")
  } else {
    console.log("  ❌ KILL — No positive executable spreads found")
    console.log("  → Move to next chain in the playbook")
  }
  console.log(`  Best spread seen: ${bestOverall.toFixed(3)}%`)
  console.log("  ═══════════════════════════════\n")

  process.exit(0)
})

main().catch(e => { console.error(e); process.exit(1) })
