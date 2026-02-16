/**
 * historical-spreads.js
 * 
 * Reconstructs cross-DEX spreads from historical block state.
 * Uses eth_call with blockTag to query pool prices at past blocks.
 * 
 * REQUIRES: Archive RPC access (public Mantle RPC may work — tested at startup)
 * 
 * Usage:
 *   node historical-spreads.js                    # 7 days, every 150 blocks (~5 min)
 *   node historical-spreads.js --days 3           # 3 days back
 *   node historical-spreads.js --interval 30      # every 30 blocks (~1 min resolution)
 *   node historical-spreads.js --days 1 --interval 30 --pairs WETH/WMNT,USDe/cmETH
 */

require("dotenv").config()
const ethers = require("ethers")
const Big = require("big.js")
const fs = require("fs")
const path = require("path")

// ── CONFIGURATION (override via CLI args) ──
const args = parseArgs()
const DAYS_BACK       = args.days     || 7
const SAMPLE_INTERVAL = args.interval || 150    // blocks (~5 min at 2s/block)
const PAIR_FILTER     = args.pairs    || null   // null = all ARB pairs
const MAX_RPC_SEC     = 25                      // conservative for public RPC
const RPC_URL         = "https://rpc.mantle.xyz"
const BLOCK_TIME_SEC  = 2

// ── LOAD CONFIG ──
const config = require("./config.json")
const { IAgniV3Pool, ILBPair } = require("./helpers/abi")

const OUTPUT_FILE = `historical_spreads_${DAYS_BACK}d_${SAMPLE_INTERVAL}blk.jsonl`
const SUMMARY_FILE = `historical_summary_${DAYS_BACK}d.txt`

// Rate limiter
let callCount = 0
let windowStart = Date.now()
async function throttle() {
  callCount++
  const elapsed = Date.now() - windowStart
  if (elapsed < 1000 && callCount >= MAX_RPC_SEC) {
    const wait = 1000 - elapsed + 50
    await sleep(wait)
    callCount = 0
    windowStart = Date.now()
  }
  if (elapsed >= 1000) {
    callCount = 1
    windowStart = Date.now()
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── MAIN ──
async function main() {
  console.log("═══════════════════════════════════════════")
  console.log("  Historical Cross-DEX Spread Backtest")
  console.log("═══════════════════════════════════════════\n")

  const provider = new ethers.JsonRpcProvider(RPC_URL)

  // Get current block
  const currentBlock = await provider.getBlockNumber()
  const blocksPerDay = Math.floor(86400 / BLOCK_TIME_SEC)
  const startBlock = currentBlock - (DAYS_BACK * blocksPerDay)
  const totalSamples = Math.floor((currentBlock - startBlock) / SAMPLE_INTERVAL)

  console.log(`  Period:   ${DAYS_BACK} days`)
  console.log(`  Blocks:   ${startBlock} → ${currentBlock}`)
  console.log(`  Interval: every ${SAMPLE_INTERVAL} blocks (~${(SAMPLE_INTERVAL * BLOCK_TIME_SEC / 60).toFixed(1)} min)`)
  console.log(`  Samples:  ~${totalSamples}`)
  console.log(`  Output:   ${OUTPUT_FILE}`)

  // ── ARCHIVE CHECK ──
  console.log(`\n── Archive Access Check ──`)
  const testBlock = startBlock + 100
  try {
    await throttle()
    // Try a simple eth_getBlockByNumber at historical block
    const block = await provider.getBlock(testBlock)
    if (!block) throw new Error("Block returned null")
    console.log(`  ✅ Archive access works (block ${testBlock} → ts ${new Date(block.timestamp * 1000).toISOString()})`)
  } catch (err) {
    console.log(`  ❌ Archive access FAILED at block ${testBlock}`)
    console.log(`     Error: ${err.message}`)
    console.log(`\n  This RPC may not support historical state queries.`)
    console.log(`  Options:`)
    console.log(`    1. Try a different RPC (Chainstack, QuickNode paid tier)`)
    console.log(`    2. Reduce --days to query only recent blocks`)
    console.log(`    3. Use --days 1 to test with last 24h only`)
    process.exit(1)
  }

  // ── SETUP PAIRS ──
  console.log(`\n── Setting Up Pairs ──`)
  const pairs = []

  for (const pairConfig of config.PAIRS) {
    if (pairConfig.mode !== "ARB") continue
    if (PAIR_FILTER && !PAIR_FILTER.includes(pairConfig.name)) continue

    try {
      await throttle()
      // Get pool addresses
      const mmFactory = new ethers.Contract(
        config.MERCHANTMOE.FACTORY,
        [{"inputs":[{"internalType":"address","name":"tokenA","type":"address"},{"internalType":"address","name":"tokenB","type":"address"},{"internalType":"uint256","name":"binStep","type":"uint256"}],"name":"getLBPairInformation","outputs":[{"components":[{"internalType":"uint16","name":"binStep","type":"uint16"},{"internalType":"address","name":"LBPair","type":"address"},{"internalType":"bool","name":"createdByOwner","type":"bool"},{"internalType":"bool","name":"ignoredForRouting","type":"bool"}],"internalType":"struct ILBFactory.LBPairInformation","name":"","type":"tuple"}],"stateMutability":"view","type":"function"}],
        provider
      )

      const agniFactory = new ethers.Contract(
        config.AGNI.FACTORY,
        [{"inputs":[{"internalType":"address","name":"","type":"address"},{"internalType":"address","name":"","type":"address"},{"internalType":"uint24","name":"","type":"uint24"}],"name":"getPool","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}],
        provider
      )

      await throttle()
      const mmInfo = await mmFactory.getLBPairInformation(
        pairConfig.ARB_FOR, pairConfig.ARB_AGAINST, pairConfig.MM_BIN_STEP
      )
      const mmPoolAddr = mmInfo.LBPair

      await throttle()
      const agniPoolAddr = await agniFactory.getPool(
        pairConfig.ARB_FOR, pairConfig.ARB_AGAINST, pairConfig.AGNI_FEE
      )

      if (!mmPoolAddr || mmPoolAddr === ethers.ZeroAddress) {
        console.log(`  ❌ ${pairConfig.name}: MM pool not found`)
        continue
      }
      if (!agniPoolAddr || agniPoolAddr === ethers.ZeroAddress) {
        console.log(`  ❌ ${pairConfig.name}: Agni pool not found`)
        continue
      }

      const mmPool = new ethers.Contract(mmPoolAddr, ILBPair, provider)
      const agniPool = new ethers.Contract(agniPoolAddr, IAgniV3Pool, provider)

      // Cache static token ordering (doesn't change across blocks)
      await throttle()
      const tokenX = (await mmPool.getTokenX()).toLowerCase()
      await throttle()
      const tokenY = (await mmPool.getTokenY()).toLowerCase()
      await throttle()
      const agniToken0 = (await agniPool.token0()).toLowerCase()

      // Get token decimals
      const IERC20_ABI = [
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)"
      ]
      await throttle()
      const token0Contract = new ethers.Contract(pairConfig.ARB_FOR, IERC20_ABI, provider)
      const token0Decimals = Number(await token0Contract.decimals())
      await throttle()
      const token0Symbol = await token0Contract.symbol()
      await throttle()
      const token1Contract = new ethers.Contract(pairConfig.ARB_AGAINST, IERC20_ABI, provider)
      const token1Decimals = Number(await token1Contract.decimals())
      await throttle()
      const token1Symbol = await token1Contract.symbol()

      // Verify historical state works for this pool
      await throttle()
      try {
        await mmPool.getActiveId({ blockTag: testBlock })
      } catch (e) {
        // Pool might not have existed at testBlock — try a more recent block
        const midBlock = Math.floor((startBlock + currentBlock) / 2)
        try {
          await throttle()
          await mmPool.getActiveId({ blockTag: midBlock })
          console.log(`  ⚠️  ${pairConfig.name}: MM pool only accessible from block ~${midBlock}`)
        } catch (e2) {
          console.log(`  ❌ ${pairConfig.name}: Cannot query historical state for MM pool`)
          continue
        }
      }

      pairs.push({
        name: pairConfig.name,
        tier: pairConfig.tier,
        mmPool,
        agniPool,
        tokenX,
        tokenY,
        agniToken0,
        token0: {
          address: pairConfig.ARB_FOR.toLowerCase(),
          decimals: token0Decimals,
          symbol: token0Symbol
        },
        token1: {
          address: pairConfig.ARB_AGAINST.toLowerCase(),
          decimals: token1Decimals,
          symbol: token1Symbol
        }
      })

      console.log(`  ✅ ${pairConfig.name} [${pairConfig.tier}] | MM: ${mmPoolAddr.slice(0,10)}... | Agni: ${agniPoolAddr.slice(0,10)}...`)
      await sleep(200) // small breathing room between pair setups

    } catch (err) {
      console.log(`  ❌ ${pairConfig.name}: ${err.message.slice(0, 80)}`)
    }
  }

  if (pairs.length === 0) {
    console.log("\n⛔ No pairs initialized. Check config and RPC.")
    process.exit(1)
  }

  console.log(`\n── Ready: ${pairs.length} pairs ──\n`)

  // ── COMPUTE SPREADS ──
  const results = []
  const startTime = Date.now()
  let processed = 0
  let errors = 0
  let skipped = 0

  // Check for existing output file to support resumption
  let lastProcessedBlock = 0
  if (fs.existsSync(OUTPUT_FILE)) {
    const lines = fs.readFileSync(OUTPUT_FILE, "utf8").trim().split("\n").filter(Boolean)
    if (lines.length > 0) {
      const lastLine = JSON.parse(lines[lines.length - 1])
      lastProcessedBlock = lastLine.block
      console.log(`  ⏩ Resuming from block ${lastProcessedBlock} (${lines.length} existing records)`)
      for (const line of lines) results.push(JSON.parse(line))
    }
  }

  const outStream = fs.createWriteStream(OUTPUT_FILE, { flags: lastProcessedBlock ? "a" : "w" })

  for (let block = startBlock; block <= currentBlock; block += SAMPLE_INTERVAL) {
    if (block <= lastProcessedBlock) {
      skipped++
      continue
    }

    processed++

    // Progress reporting every 50 samples
    if (processed % 50 === 0 || processed === 1) {
      const pct = ((block - startBlock) / (currentBlock - startBlock) * 100).toFixed(1)
      const elapsed = (Date.now() - startTime) / 1000
      const rate = processed / elapsed
      const remaining = (totalSamples - processed) / rate
      process.stdout.write(
        `\r  Block ${block} | ${pct}% | ${processed}/${totalSamples} samples | ` +
        `${rate.toFixed(1)} samples/s | ETA ${formatTime(remaining)}    `
      )
    }

    for (const pair of pairs) {
      try {
        // ── Get LB price at historical block ──
        await throttle()
        let activeId
        try {
          activeId = await pair.mmPool.getActiveId({ blockTag: block })
        } catch (e) {
          continue // pool may not exist at this block
        }

        await throttle()
        const priceX128 = await pair.mmPool.getPriceFromId(activeId, { blockTag: block })
        if (!priceX128) continue

        const rawLB = Big(priceX128.toString()).div(Big(2).pow(128))

        let mmPrice
        if (pair.token0.address === pair.tokenX && pair.token1.address === pair.tokenY) {
          mmPrice = rawLB.mul(Big(10).pow(pair.token0.decimals - pair.token1.decimals))
        } else if (pair.token0.address === pair.tokenY && pair.token1.address === pair.tokenX) {
          mmPrice = Big(1).div(rawLB).mul(Big(10).pow(pair.token0.decimals - pair.token1.decimals))
        } else {
          continue
        }

        // ── Get V3 price at historical block ──
        await throttle()
        let slot0
        try {
          slot0 = await pair.agniPool.slot0({ blockTag: block })
        } catch (e) {
          continue
        }

        const sqrtPriceX96 = slot0[0]
        const sqrt = Big(sqrtPriceX96.toString())
        const rawV3 = sqrt.mul(sqrt).div(Big(2).pow(192))

        let agniPrice
        if (pair.token0.address === pair.agniToken0) {
          agniPrice = rawV3.mul(Big(10).pow(pair.token0.decimals - pair.token1.decimals))
        } else {
          agniPrice = Big(1).div(rawV3).mul(Big(10).pow(pair.token0.decimals - pair.token1.decimals))
        }

        // ── Compute spread ──
        if (mmPrice.eq(0) || agniPrice.eq(0)) continue

        const spread = mmPrice.minus(agniPrice).div(agniPrice).mul(100)
        const spreadAbs = spread.abs()

        const record = {
          block,
          pair: pair.name,
          tier: pair.tier,
          mmPrice: Number(mmPrice).toFixed(8),
          agniPrice: Number(agniPrice).toFixed(8),
          spread: Number(spread).toFixed(4),
          spreadAbs: Number(spreadAbs).toFixed(4),
          direction: Number(spread) > 0 ? "MM→Agni" : "Agni→MM"
        }

        results.push(record)
        outStream.write(JSON.stringify(record) + "\n")

      } catch (err) {
        errors++
        if (errors < 10) {
          // Log first few errors for debugging
          process.stderr.write(`\n  ⚠️ ${pair.name} @ block ${block}: ${err.message.slice(0, 60)}\n`)
        }
      }
    }
  }

  outStream.end()
  process.stdout.write("\n\n")

  const totalTime = (Date.now() - startTime) / 1000
  console.log(`── Scan Complete ──`)
  console.log(`  Time: ${formatTime(totalTime)}`)
  console.log(`  Samples: ${processed}`)
  console.log(`  Records: ${results.length}`)
  console.log(`  Errors: ${errors}`)
  console.log(`  Output: ${OUTPUT_FILE}\n`)

  // ── ANALYSIS ──
  if (results.length === 0) {
    console.log("⛔ No data collected. Check RPC archive access.")
    process.exit(1)
  }

  generateReport(results, startBlock, currentBlock)
}

function generateReport(results, startBlock, endBlock) {
  console.log("═══════════════════════════════════════════")
  console.log("  HISTORICAL BACKTEST RESULTS")
  console.log("═══════════════════════════════════════════\n")

  const byPair = {}
  for (const r of results) {
    if (!byPair[r.pair]) byPair[r.pair] = []
    byPair[r.pair].push(r)
  }

  const reportLines = []
  const log = (s) => { console.log(s); reportLines.push(s) }

  log(`Period: ${DAYS_BACK} days | Blocks: ${startBlock}–${endBlock}`)
  log(`Interval: every ${SAMPLE_INTERVAL} blocks (~${(SAMPLE_INTERVAL * BLOCK_TIME_SEC / 60).toFixed(1)} min)`)
  log(`Total records: ${results.length}\n`)

  const pairSummaries = []

  for (const [pair, records] of Object.entries(byPair).sort((a, b) => b[1].length - a[1].length)) {
    const spreads = records.map(r => parseFloat(r.spreadAbs))
    const signedSpreads = records.map(r => parseFloat(r.spread))

    spreads.sort((a, b) => a - b)
    const n = spreads.length
    const mean = spreads.reduce((a, b) => a + b, 0) / n
    const median = n % 2 === 0
      ? (spreads[n / 2 - 1] + spreads[n / 2]) / 2
      : spreads[Math.floor(n / 2)]
    const max = spreads[n - 1]
    const p90 = spreads[Math.floor(n * 0.9)]
    const p95 = spreads[Math.floor(n * 0.95)]
    const p99 = spreads[Math.floor(n * 0.99)]

    const above01 = spreads.filter(s => s >= 0.1).length
    const above02 = spreads.filter(s => s >= 0.2).length
    const above03 = spreads.filter(s => s >= 0.3).length
    const above05 = spreads.filter(s => s >= 0.5).length
    const above10 = spreads.filter(s => s >= 1.0).length

    const mmToAgni = records.filter(r => r.direction === "MM→Agni").length
    const agniToMM = records.filter(r => r.direction === "Agni→MM").length

    // Spike detection: consecutive blocks above threshold
    const sortedByBlock = [...records].sort((a, b) => a.block - b.block)
    let spikes03 = 0, currentSpike = false
    let spikeDurations = []
    let spikeStart = 0
    for (const r of sortedByBlock) {
      if (parseFloat(r.spreadAbs) >= 0.3) {
        if (!currentSpike) {
          currentSpike = true
          spikeStart = r.block
          spikes03++
        }
      } else {
        if (currentSpike) {
          spikeDurations.push(r.block - spikeStart)
          currentSpike = false
        }
      }
    }
    if (currentSpike && sortedByBlock.length > 0) {
      spikeDurations.push(sortedByBlock[sortedByBlock.length - 1].block - spikeStart)
    }
    const medianSpikeDuration = spikeDurations.length > 0
      ? spikeDurations.sort((a, b) => a - b)[Math.floor(spikeDurations.length / 2)]
      : 0

    // Paper profit estimation (using $2000 trade size, $0.05 gas)
    const paperProfits = spreads.map(s => (s / 100) * 2000 - 0.05)
    const profitableTrades = paperProfits.filter(p => p > 0).length
    const totalPaperProfit = paperProfits.filter(p => p > 0).reduce((a, b) => a + b, 0)
    const avgPaperProfit = profitableTrades > 0 ? totalPaperProfit / profitableTrades : 0

    const tier = records[0]?.tier || "?"

    log(`┌─ ${pair} [${tier}] ─────────────────────────`)
    log(`│  Samples: ${n}`)
    log(`│`)
    log(`│  Spread Distribution (absolute):`)
    log(`│    Mean:   ${mean.toFixed(4)}%`)
    log(`│    Median: ${median.toFixed(4)}%`)
    log(`│    P90:    ${p90.toFixed(4)}%`)
    log(`│    P95:    ${p95.toFixed(4)}%`)
    log(`│    P99:    ${p99.toFixed(4)}%`)
    log(`│    Max:    ${max.toFixed(4)}%`)
    log(`│`)
    log(`│  Threshold Counts:`)
    log(`│    ≥0.1%:  ${above01} (${(above01 / n * 100).toFixed(1)}%)`)
    log(`│    ≥0.2%:  ${above02} (${(above02 / n * 100).toFixed(1)}%)`)
    log(`│    ≥0.3%:  ${above03} (${(above03 / n * 100).toFixed(1)}%)`)
    log(`│    ≥0.5%:  ${above05} (${(above05 / n * 100).toFixed(1)}%)`)
    log(`│    ≥1.0%:  ${above10} (${(above10 / n * 100).toFixed(1)}%)`)
    log(`│`)
    log(`│  Direction: MM→Agni ${mmToAgni} (${(mmToAgni / n * 100).toFixed(0)}%) | Agni→MM ${agniToMM} (${(agniToMM / n * 100).toFixed(0)}%)`)
    log(`│`)
    log(`│  Spike Analysis (≥0.3% events):`)
    log(`│    Count: ${spikes03} events`)
    log(`│    Median duration: ~${medianSpikeDuration} blocks (~${(medianSpikeDuration * BLOCK_TIME_SEC).toFixed(0)}s)`)
    log(`│`)
    log(`│  Paper P&L ($2k size, $0.05 gas):`)
    log(`│    Profitable samples: ${profitableTrades} / ${n} (${(profitableTrades / n * 100).toFixed(1)}%)`)
    log(`│    Total paper profit: $${totalPaperProfit.toFixed(2)}`)
    log(`│    Avg per profitable: $${avgPaperProfit.toFixed(2)}`)
    log(`└──────────────────────────────────────────\n`)

    pairSummaries.push({
      pair, tier, n, mean, median, max, p90, p95,
      above01pct: above01 / n * 100,
      above03pct: above03 / n * 100,
      above05pct: above05 / n * 100,
      spikes03, medianSpikeDuration,
      totalPaperProfit, profitableTrades,
      directionBalance: Math.min(mmToAgni, agniToMM) / Math.max(mmToAgni, agniToMM) * 100
    })
  }

  // ── RANKING ──
  log(`═══════════════════════════════════════════`)
  log(`  PAIR RANKING (by edge quality)`)
  log(`═══════════════════════════════════════════\n`)

  // Score: weighted combo of frequency, magnitude, and direction balance
  pairSummaries.sort((a, b) => {
    const scoreA = a.above03pct * 0.4 + a.mean * 100 * 0.3 + a.directionBalance * 0.3
    const scoreB = b.above03pct * 0.4 + b.mean * 100 * 0.3 + b.directionBalance * 0.3
    return scoreB - scoreA
  })

  for (let i = 0; i < pairSummaries.length; i++) {
    const s = pairSummaries[i]
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  "
    log(`  ${medal} #${i + 1} ${s.pair} [${s.tier}]`)
    log(`     Mean: ${s.mean.toFixed(3)}% | ≥0.3%: ${s.above03pct.toFixed(1)}% | ≥0.5%: ${s.above05pct.toFixed(1)}%`)
    log(`     P90: ${s.p90.toFixed(3)}% | Max: ${s.max.toFixed(3)}% | Dir balance: ${s.directionBalance.toFixed(0)}%`)
    log(`     Paper profit: $${s.totalPaperProfit.toFixed(2)} over ${DAYS_BACK}d | Spikes(≥0.3%): ${s.spikes03}`)
    log("")
  }

  // ── VERDICT ──
  log(`═══════════════════════════════════════════`)
  log(`  EDGE VERDICT`)
  log(`═══════════════════════════════════════════\n`)

  const topPair = pairSummaries[0]
  if (topPair) {
    if (topPair.above03pct >= 10 && topPair.mean >= 0.15) {
      log(`  ✅ STRUCTURAL EDGE DETECTED`)
      log(`     ${topPair.pair} shows ≥0.3% spread ${topPair.above03pct.toFixed(1)}% of the time`)
      log(`     Mean spread ${topPair.mean.toFixed(3)}% is persistent, not a fluke`)
      log(`     → Proceed to slippage simulation + live micro-test`)
    } else if (topPair.above03pct >= 3 || topPair.mean >= 0.08) {
      log(`  🟡 MARGINAL EDGE — needs more analysis`)
      log(`     ${topPair.pair} shows some spreads but frequency is low`)
      log(`     → Run 30-day backtest for higher confidence`)
      log(`     → Check if spreads cluster around specific times (volatility events)`)
    } else {
      log(`  ❌ NO STRUCTURAL EDGE FOUND`)
      log(`     Spreads are too small or too rare for profitable execution`)
      log(`     → Consider different pairs or chains`)
    }
  }

  log("")

  // Save report
  fs.writeFileSync(SUMMARY_FILE, reportLines.join("\n"))
  console.log(`\n  Report saved: ${SUMMARY_FILE}`)
  console.log(`  Raw data: ${OUTPUT_FILE}`)

  // ── COMPARISON WITH LIVE DATA ──
  const paperTradeFiles = fs.readdirSync(".").filter(f => f.startsWith("paper_trades_") && f.endsWith(".jsonl"))
  if (paperTradeFiles.length > 0) {
    console.log(`\n═══════════════════════════════════════════`)
    console.log(`  LIVE vs HISTORICAL COMPARISON`)
    console.log(`═══════════════════════════════════════════\n`)

    let liveTrades = []
    for (const f of paperTradeFiles) {
      const lines = fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
      for (const line of lines) liveTrades.push(JSON.parse(line))
    }

    const liveByPair = {}
    for (const t of liveTrades) {
      if (!liveByPair[t.pair]) liveByPair[t.pair] = []
      liveByPair[t.pair].push(t)
    }

    for (const [pair, hist] of Object.entries(byPair)) {
      // Try to match live pair name (live may have reversed token order)
      const livePairs = Object.keys(liveByPair)
      const matchKey = livePairs.find(lp => {
        const parts = pair.split("/")
        return lp === pair || lp === `${parts[1]}/${parts[0]}`
      })

      if (!matchKey) continue
      const live = liveByPair[matchKey]

      const histSpreads = hist.map(r => parseFloat(r.spreadAbs))
      const liveSpreads = live.map(t => Math.abs(parseFloat(t.spread)))

      const histMean = histSpreads.reduce((a, b) => a + b, 0) / histSpreads.length
      const liveMean = liveSpreads.reduce((a, b) => a + b, 0) / liveSpreads.length

      console.log(`  ${pair}:`)
      console.log(`    Historical mean: ${histMean.toFixed(4)}% (${histSpreads.length} samples)`)
      console.log(`    Live mean:       ${liveMean.toFixed(4)}% (${liveSpreads.length} samples)`)

      const ratio = liveMean / histMean
      if (ratio > 1.5) {
        console.log(`    ⚠️  Live spreads ${ratio.toFixed(1)}x wider than historical — may have caught a volatile window`)
      } else if (ratio < 0.5) {
        console.log(`    ⚠️  Live spreads ${ratio.toFixed(1)}x tighter than historical — conditions may have changed`)
      } else {
        console.log(`    ✅ Consistent (ratio: ${ratio.toFixed(2)}x) — STRUCTURAL edge`)
      }
      console.log()
    }
  }
}

// ── HELPERS ──

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function parseArgs() {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) args.days = parseInt(argv[i + 1])
    if (argv[i] === "--interval" && argv[i + 1]) args.interval = parseInt(argv[i + 1])
    if (argv[i] === "--pairs" && argv[i + 1]) args.pairs = argv[i + 1].split(",")
  }
  return args
}

main().catch(err => {
  console.error("\n⛔ Fatal error:", err.message)
  process.exit(1)
})
