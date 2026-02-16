/**
 * slippage-simulator.js
 * 
 * PURPOSE: Attempt to KILL the WMNT/WETH edge.
 * If it survives pessimistic assumptions, it's real.
 * 
 * Simulates FULL round-trip arbitrage execution:
 *   Flash borrow WMNT → Swap on DEX A → Swap on DEX B → Repay → Compute net
 * 
 * Uses ON-CHAIN quoter contracts (not manual math):
 *   - Agni V3: QuoterV2.quoteExactInputSingle
 *   - Merchant Moe LB: LBPair.getSwapOut
 * 
 * Tests multiple sizes, both directions, includes all fees.
 * 
 * Usage:
 *   node slippage-simulator.js                          # single snapshot
 *   node slippage-simulator.js --repeat 10 --delay 60   # 10 runs, 60s apart
 *   node slippage-simulator.js --pair cmETH/USDe         # different pair
 */

require("dotenv").config()
const ethers = require("ethers")
const Big = require("big.js")
const fs = require("fs")

const config = require("./config.json")
const { IAgniV3Pool, ILBPair } = require("./helpers/abi")

// ── CLI ARGS ──
const args = parseArgs()
const PAIR_NAME = args.pair || "WMNT/WETH"
const REPEAT = args.repeat || 1
const DELAY_SEC = args.delay || 30

// ── CONSTANTS ──
const RPC_URL = config.RPC.HTTP
const TRADE_SIZES_USD = [100, 300, 500, 1000, 2000, 5000]
const BALANCER_FLASH_FEE_PCT = 0        // Balancer V2 = 0% flash loan fee
const GAS_COST_USD = 0.05               // conservative Mantle gas estimate
const EXTRA_SLIPPAGE_BUFFER_PCT = 0.05  // 0.05% pessimism buffer
const WETH_USD_FALLBACK = 2700          // fallback if can't fetch live

// ── ABIs ──
const QUOTER_V2_ABI = [
  {
    "inputs": [{
      "components": [
        { "internalType": "address", "name": "tokenIn", "type": "address" },
        { "internalType": "address", "name": "tokenOut", "type": "address" },
        { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
        { "internalType": "uint24", "name": "fee", "type": "uint24" },
        { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
      ],
      "internalType": "struct IQuoterV2.QuoteExactInputSingleParams",
      "name": "params",
      "type": "tuple"
    }],
    "name": "quoteExactInputSingle",
    "outputs": [
      { "internalType": "uint256", "name": "amountOut", "type": "uint256" },
      { "internalType": "uint160", "name": "sqrtPriceX96After", "type": "uint160" },
      { "internalType": "uint32", "name": "initializedTicksCrossed", "type": "uint32" },
      { "internalType": "uint256", "name": "gasEstimate", "type": "uint256" }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
]

const LB_PAIR_QUOTE_ABI = [
  ...ILBPair,
  {
    "inputs": [
      { "internalType": "uint128", "name": "amountIn", "type": "uint128" },
      { "internalType": "bool", "name": "swapForY", "type": "bool" }
    ],
    "name": "getSwapOut",
    "outputs": [
      { "internalType": "uint128", "name": "amountInLeft", "type": "uint128" },
      { "internalType": "uint128", "name": "amountOut", "type": "uint128" },
      { "internalType": "uint128", "name": "fee", "type": "uint128" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
]

const IERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)"
]

// ── MAIN ──
async function main() {
  console.log("═══════════════════════════════════════════════")
  console.log("  Slippage & Execution Simulator")
  console.log("  Purpose: KILL the edge or prove it survives")
  console.log("═══════════════════════════════════════════════\n")

  const provider = new ethers.JsonRpcProvider(RPC_URL)

  // Find pair config
  const pairConfig = config.PAIRS.find(p => p.name === PAIR_NAME && p.mode === "ARB")
  if (!pairConfig) {
    console.log(`⛔ Pair ${PAIR_NAME} not found in config (or mode != ARB)`)
    process.exit(1)
  }

  // Setup tokens
  const token0Contract = new ethers.Contract(pairConfig.ARB_FOR, IERC20_ABI, provider)
  const token1Contract = new ethers.Contract(pairConfig.ARB_AGAINST, IERC20_ABI, provider)

  const token0 = {
    address: pairConfig.ARB_FOR,
    symbol: await token0Contract.symbol(),
    decimals: Number(await token0Contract.decimals())
  }
  const token1 = {
    address: pairConfig.ARB_AGAINST,
    symbol: await token1Contract.symbol(),
    decimals: Number(await token1Contract.decimals())
  }

  console.log(`  Pair:    ${token0.symbol}/${token1.symbol}`)
  console.log(`  Token0:  ${token0.symbol} (${token0.decimals} decimals) — ${token0.address}`)
  console.log(`  Token1:  ${token1.symbol} (${token1.decimals} decimals) — ${token1.address}`)

  // Setup Agni QuoterV2
  const agniQuoter = new ethers.Contract(config.AGNI.QUOTER_V2, QUOTER_V2_ABI, provider)

  // Setup MM LB pool
  const mmFactory = new ethers.Contract(
    config.MERCHANTMOE.FACTORY,
    [{
      "inputs": [
        { "internalType": "address", "name": "tokenA", "type": "address" },
        { "internalType": "address", "name": "tokenB", "type": "address" },
        { "internalType": "uint256", "name": "binStep", "type": "uint256" }
      ],
      "name": "getLBPairInformation",
      "outputs": [{
        "components": [
          { "internalType": "uint16", "name": "binStep", "type": "uint16" },
          { "internalType": "address", "name": "LBPair", "type": "address" },
          { "internalType": "bool", "name": "createdByOwner", "type": "bool" },
          { "internalType": "bool", "name": "ignoredForRouting", "type": "bool" }
        ],
        "internalType": "struct ILBFactory.LBPairInformation",
        "name": "",
        "type": "tuple"
      }],
      "stateMutability": "view",
      "type": "function"
    }],
    provider
  )

  const mmInfo = await mmFactory.getLBPairInformation(token0.address, token1.address, pairConfig.MM_BIN_STEP)
  const mmPool = new ethers.Contract(mmInfo.LBPair, LB_PAIR_QUOTE_ABI, provider)

  // Get LB token ordering
  const tokenX = (await mmPool.getTokenX()).toLowerCase()
  const tokenY = (await mmPool.getTokenY()).toLowerCase()

  console.log(`\n  MM LB Pool:   ${mmInfo.LBPair}`)
  console.log(`    TokenX: ${tokenX === token0.address.toLowerCase() ? token0.symbol : token1.symbol}`)
  console.log(`    TokenY: ${tokenY === token0.address.toLowerCase() ? token0.symbol : token1.symbol}`)

  // Setup Agni pool for price reading
  const agniFactory = new ethers.Contract(
    config.AGNI.FACTORY,
    [{ "inputs": [{"type":"address"},{"type":"address"},{"type":"uint24"}], "name": "getPool", "outputs": [{"type":"address"}], "stateMutability": "view", "type": "function" }],
    provider
  )
  const agniPoolAddr = await agniFactory.getPool(token0.address, token1.address, pairConfig.AGNI_FEE)
  const agniPool = new ethers.Contract(agniPoolAddr, IAgniV3Pool, provider)

  console.log(`  Agni V3 Pool: ${agniPoolAddr}`)
  console.log(`  Agni Fee:     ${pairConfig.AGNI_FEE / 10000}%`)

  // Estimate token0 price in USD (for size conversion)
  const token0PriceUSD = await estimateToken0PriceUSD(provider, token0, token1, agniPool, config)
  console.log(`\n  ${token0.symbol} price: ~$${token0PriceUSD.toFixed(4)}`)
  console.log(`  Sizes to test: ${TRADE_SIZES_USD.map(s => '$' + s).join(', ')}`)
  console.log(`  Flash loan fee: ${BALANCER_FLASH_FEE_PCT}%`)
  console.log(`  Gas cost: $${GAS_COST_USD}`)
  console.log(`  Safety buffer: ${EXTRA_SLIPPAGE_BUFFER_PCT}%`)

  // ── RUN SIMULATIONS ──
  const allResults = []

  for (let run = 0; run < REPEAT; run++) {
    if (REPEAT > 1) {
      console.log(`\n━━━ Run ${run + 1}/${REPEAT} ━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    }

    const block = await provider.getBlockNumber()
    const timestamp = new Date().toISOString()

    console.log(`\n  Block: ${block} | Time: ${timestamp}`)

    // Get current mid-prices for reference
    const { mmMidPrice, agniMidPrice, midSpread } = await getMidPrices(
      mmPool, agniPool, token0, token1, tokenX, tokenY
    )

    console.log(`\n  ── Current Mid-Prices ──`)
    console.log(`  MM LB:     1 ${token1.symbol} = ${Number(mmMidPrice).toFixed(6)} ${token0.symbol}`)
    console.log(`  Agni V3:   1 ${token1.symbol} = ${Number(agniMidPrice).toFixed(6)} ${token0.symbol}`)
    console.log(`  Mid-spread: ${midSpread.toFixed(4)}%`)

    const direction1Label = `Buy ${token1.symbol} on MM → Sell on Agni`
    const direction2Label = `Buy ${token1.symbol} on Agni → Sell on MM`

    // Determine which direction the spread favors
    const mmCheaper = Number(midSpread) > 0 // MM price < Agni price → buy on MM

    console.log(`\n  ══════════════════════════════════════════════`)
    console.log(`  Direction 1: ${direction1Label}`)
    console.log(`  (Flash borrow ${token0.symbol} → buy ${token1.symbol} on MM → sell on Agni → repay)`)
    console.log(`  ══════════════════════════════════════════════\n`)

    const d1Results = await simulateDirection(
      "MM→Agni", token0, token1, tokenX, tokenY,
      mmPool, agniQuoter, pairConfig,
      token0PriceUSD, block, timestamp,
      true // buyOnMM
    )

    console.log(`\n  ══════════════════════════════════════════════`)
    console.log(`  Direction 2: ${direction2Label}`)
    console.log(`  (Flash borrow ${token0.symbol} → buy ${token1.symbol} on Agni → sell on MM → repay)`)
    console.log(`  ══════════════════════════════════════════════\n`)

    const d2Results = await simulateDirection(
      "Agni→MM", token0, token1, tokenX, tokenY,
      mmPool, agniQuoter, pairConfig,
      token0PriceUSD, block, timestamp,
      false // buyOnAgni
    )

    // Best direction for this snapshot
    const bestD1 = d1Results.find(r => r.netProfitUSD > 0)
    const bestD2 = d2Results.find(r => r.netProfitUSD > 0)

    console.log(`\n  ── SNAPSHOT VERDICT ──`)
    if (!bestD1 && !bestD2) {
      console.log(`  ❌ No profitable direction at any size right now`)
      console.log(`     Mid-spread: ${midSpread.toFixed(4)}% — may need >0.15% for execution`)
    } else {
      const best = (bestD1 && bestD2)
        ? (bestD1.netProfitUSD > bestD2.netProfitUSD ? bestD1 : bestD2)
        : (bestD1 || bestD2)
      console.log(`  ✅ Profitable: ${best.direction} @ $${best.sizeUSD}`)
      console.log(`     Net: $${best.netProfitUSD.toFixed(4)} (${best.netProfitPct.toFixed(4)}%)`)
      console.log(`     After ${EXTRA_SLIPPAGE_BUFFER_PCT}% safety buffer: $${best.netAfterBuffer.toFixed(4)}`)
    }

    allResults.push(...d1Results, ...d2Results)

    if (run < REPEAT - 1) {
      console.log(`\n  Waiting ${DELAY_SEC}s before next run...`)
      await sleep(DELAY_SEC * 1000)
    }
  }

  // ── AGGREGATE REPORT ──
  if (REPEAT > 1) {
    generateAggregateReport(allResults)
  }

  // Save results
  const outFile = `slippage_results_${PAIR_NAME.replace('/', '_')}_${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.jsonl`
  const outStream = fs.createWriteStream(outFile)
  for (const r of allResults) {
    outStream.write(JSON.stringify(r) + "\n")
  }
  outStream.end()
  console.log(`\n  Results saved: ${outFile}`)
}

async function simulateDirection(
  dirLabel, token0, token1, tokenX, tokenY,
  mmPool, agniQuoter, pairConfig,
  token0PriceUSD, block, timestamp,
  buyOnMM
) {
  const results = []

  // Table header
  const rows = []

  for (const sizeUSD of TRADE_SIZES_USD) {
    try {
      // Convert USD to token0 amount
      const token0Amount = BigInt(
        Big(sizeUSD).div(token0PriceUSD).mul(Big(10).pow(token0.decimals)).round().toFixed(0)
      )

      let leg1Out, leg2Out, leg1Fee, leg2TicksCrossed

      if (buyOnMM) {
        // LEG 1: Swap token0 → token1 on Merchant Moe LB
        const swapForY_leg1 = token0.address.toLowerCase() === tokenX
        const [amountInLeft, mmOut, mmFee] = await mmPool.getSwapOut(token0Amount, swapForY_leg1)
        leg1Out = mmOut
        leg1Fee = mmFee

        if (leg1Out === 0n) {
          rows.push({ sizeUSD, status: "MM: zero output", netProfitUSD: -999 })
          continue
        }

        // LEG 2: Swap token1 → token0 on Agni V3
        const [agniOut, , ticksCrossed] = await agniQuoter.quoteExactInputSingle.staticCall({
          tokenIn: token1.address,
          tokenOut: token0.address,
          amountIn: leg1Out,
          fee: pairConfig.AGNI_FEE,
          sqrtPriceLimitX96: 0
        })
        leg2Out = agniOut
        leg2TicksCrossed = ticksCrossed

      } else {
        // LEG 1: Swap token0 → token1 on Agni V3
        const [agniOut, , ticksCrossed] = await agniQuoter.quoteExactInputSingle.staticCall({
          tokenIn: token0.address,
          tokenOut: token1.address,
          amountIn: token0Amount,
          fee: pairConfig.AGNI_FEE,
          sqrtPriceLimitX96: 0
        })
        leg1Out = agniOut
        leg2TicksCrossed = ticksCrossed
        leg1Fee = 0n

        if (leg1Out === 0n) {
          rows.push({ sizeUSD, status: "Agni: zero output", netProfitUSD: -999 })
          continue
        }

        // LEG 2: Swap token1 → token0 on Merchant Moe LB
        const swapForY_leg2 = token1.address.toLowerCase() === tokenX
        const [amountInLeft, mmOut, mmFee] = await mmPool.getSwapOut(leg1Out, swapForY_leg2)
        leg2Out = mmOut
        leg1Fee = mmFee
      }

      // ── COMPUTE P&L ──
      const flashLoanFee = token0Amount * BigInt(Math.floor(BALANCER_FLASH_FEE_PCT * 100)) / 10000n
      const repayAmount = token0Amount + flashLoanFee

      const grossProfit = leg2Out - repayAmount // in token0 smallest units
      const grossProfitFloat = Number(ethers.formatUnits(grossProfit, token0.decimals))
      const grossProfitUSD = grossProfitFloat * token0PriceUSD

      const netProfitUSD = grossProfitUSD - GAS_COST_USD
      const netProfitPct = (netProfitUSD / sizeUSD) * 100

      // Apply pessimism buffer
      const bufferCost = sizeUSD * (EXTRA_SLIPPAGE_BUFFER_PCT / 100)
      const netAfterBuffer = netProfitUSD - bufferCost

      const token0In = Number(ethers.formatUnits(token0Amount, token0.decimals))
      const token1Mid = Number(ethers.formatUnits(leg1Out, token1.decimals))
      const token0Out = Number(ethers.formatUnits(leg2Out, token0.decimals))

      // Smart formatting based on magnitude
      const fmt = (n) => {
        if (Math.abs(n) >= 1000) return n.toFixed(1)
        if (Math.abs(n) >= 1) return n.toFixed(3)
        if (Math.abs(n) >= 0.001) return n.toFixed(5)
        return n.toFixed(8)
      }

      // Price impact: how much worse than mid-price did we get?
      const effectiveRate = token0Out / token0In
      const priceImpact = ((1 - effectiveRate) * 100) // total round-trip cost in %

      const row = {
        sizeUSD,
        direction: dirLabel,
        block,
        timestamp,
        token0In: fmt(token0In),
        token1Mid: fmt(token1Mid),
        token0Out: fmt(token0Out),
        grossProfitToken0: grossProfitFloat.toFixed(6),
        grossProfitUSD: grossProfitUSD,
        gasCostUSD: GAS_COST_USD,
        netProfitUSD: netProfitUSD,
        netProfitPct: netProfitPct,
        bufferCostUSD: bufferCost,
        netAfterBuffer: netAfterBuffer,
        roundTripCostPct: priceImpact,
        ticksCrossed: Number(leg2TicksCrossed || 0),
        status: netAfterBuffer > 0 ? "✅ PROFITABLE" : netProfitUSD > 0 ? "🟡 MARGINAL" : "❌ UNPROFITABLE"
      }

      rows.push(row)
      results.push(row)

    } catch (err) {
      rows.push({
        sizeUSD,
        direction: dirLabel,
        status: `⚠️ ERROR: ${err.message.slice(0, 60)}`,
        netProfitUSD: -999
      })
    }
  }

  // Print table
  const pad = (s, n) => String(s).padStart(n)
  const t0s = token0.symbol.slice(0, 5)
  const t1s = token1.symbol.slice(0, 5)
  console.log(`  ${pad('Size',7)} | ${pad(t0s+' In',12)} | ${pad(t1s+' Mid',12)} | ${pad(t0s+' Out',12)} | ${pad('Gross',9)} | ${pad('Net',9)} | ${pad('Net%',8)} | ${pad('R/T Cost',8)} | Status`)
  console.log(`  ${'-'.repeat(110)}`)

  for (const r of rows) {
    if (r.netProfitUSD === -999) {
      console.log(`  ${pad('$' + r.sizeUSD, 7)} | ${r.status}`)
      continue
    }
    console.log(
      `  ${pad('$' + r.sizeUSD, 7)}` +
      ` | ${pad(r.token0In, 12)}` +
      ` | ${pad(r.token1Mid, 12)}` +
      ` | ${pad(r.token0Out, 12)}` +
      ` | ${pad('$' + r.grossProfitUSD.toFixed(3), 9)}` +
      ` | ${pad('$' + r.netProfitUSD.toFixed(3), 9)}` +
      ` | ${pad(r.netProfitPct.toFixed(3) + '%', 8)}` +
      ` | ${pad(r.roundTripCostPct.toFixed(3) + '%', 8)}` +
      ` | ${r.status}`
    )
  }

  return results
}

function generateAggregateReport(allResults) {
  console.log(`\n═══════════════════════════════════════════════`)
  console.log(`  AGGREGATE RESULTS (${REPEAT} snapshots)`)
  console.log(`═══════════════════════════════════════════════\n`)

  // Group by size + direction
  const groups = {}
  for (const r of allResults) {
    if (r.netProfitUSD === -999) continue
    const key = `${r.direction}|$${r.sizeUSD}`
    if (!groups[key]) groups[key] = []
    groups[key].push(r)
  }

  const pad = (s, n) => String(s).padStart(n)
  console.log(`  ${pad('Direction',10)} | ${pad('Size',6)} | ${pad('Avg Net',9)} | ${pad('Win%',6)} | ${pad('Avg R/T',8)} | ${pad('Best',9)} | ${pad('Worst',9)}`)
  console.log(`  ${'-'.repeat(80)}`)

  for (const [key, runs] of Object.entries(groups).sort()) {
    const [dir, size] = key.split('|')
    const nets = runs.map(r => r.netAfterBuffer)
    const avg = nets.reduce((a, b) => a + b, 0) / nets.length
    const wins = nets.filter(n => n > 0).length
    const rtcs = runs.map(r => r.roundTripCostPct)
    const avgRTC = rtcs.reduce((a, b) => a + b, 0) / rtcs.length

    console.log(
      `  ${pad(dir, 10)} | ${pad(size, 6)}` +
      ` | ${pad('$' + avg.toFixed(3), 9)}` +
      ` | ${pad((wins / nets.length * 100).toFixed(0) + '%', 6)}` +
      ` | ${pad(avgRTC.toFixed(3) + '%', 8)}` +
      ` | ${pad('$' + Math.max(...nets).toFixed(3), 9)}` +
      ` | ${pad('$' + Math.min(...nets).toFixed(3), 9)}`
    )
  }
}

async function getMidPrices(mmPool, agniPool, token0, token1, tokenX, tokenY) {
  // MM LB mid price
  const activeId = await mmPool.getActiveId()
  const priceX128 = await mmPool.getPriceFromId(activeId)
  const rawLB = Big(priceX128.toString()).div(Big(2).pow(128))

  let mmMidPrice
  if (token0.address.toLowerCase() === tokenX) {
    mmMidPrice = rawLB.mul(Big(10).pow(token0.decimals - token1.decimals))
  } else {
    mmMidPrice = Big(1).div(rawLB).mul(Big(10).pow(token0.decimals - token1.decimals))
  }

  // Agni V3 mid price
  const [sqrtPriceX96] = await agniPool.slot0()
  const agniToken0 = (await agniPool.token0()).toLowerCase()
  const sqrt = Big(sqrtPriceX96.toString())
  const rawV3 = sqrt.mul(sqrt).div(Big(2).pow(192))

  let agniMidPrice
  if (token0.address.toLowerCase() === agniToken0) {
    agniMidPrice = rawV3.mul(Big(10).pow(token0.decimals - token1.decimals))
  } else {
    agniMidPrice = Big(1).div(rawV3).mul(Big(10).pow(token0.decimals - token1.decimals))
  }

  const midSpread = Number(mmMidPrice.minus(agniMidPrice).div(agniMidPrice).mul(100))

  return { mmMidPrice, agniMidPrice, midSpread }
}

async function estimateToken0PriceUSD(provider, token0, token1, agniPool, config) {
  // For WMNT/WETH pair: token0 = WMNT, token1 = WETH
  // WMNT price = (WMNT/WETH rate) × WETH_USD

  // Get token0/token1 rate from Agni pool
  const [sqrtPriceX96] = await agniPool.slot0()
  const agniToken0 = (await agniPool.token0()).toLowerCase()
  const sqrt = Big(sqrtPriceX96.toString())
  const rawV3 = sqrt.mul(sqrt).div(Big(2).pow(192))

  // V3 convention: rawV3 = pool_token1 / pool_token0 (in raw units)
  // We need: how many of our token0 per 1 of our token1
  let rateToken0PerToken1
  if (token0.address.toLowerCase() === agniToken0) {
    // our token0 = pool_token0 → rawV3 = our_token1 / our_token0
    // token0_per_token1 = 1/rawV3, adjusted for decimals
    rateToken0PerToken1 = Big(1).div(rawV3).mul(Big(10).pow(token1.decimals - token0.decimals))
  } else {
    // our token0 = pool_token1 → rawV3 = our_token0 / our_token1
    // token0_per_token1 = rawV3, adjusted for decimals
    rateToken0PerToken1 = rawV3.mul(Big(10).pow(token1.decimals - token0.decimals))
  }

  // Determine USD price based on what token1 is
  const t1sym = token1.symbol.toUpperCase()
  let token1USD

  if (t1sym === "WETH" || t1sym === "ETH") {
    // Try to get WETH price from USDT/WETH or USDC/WETH pool
    token1USD = WETH_USD_FALLBACK
    try {
      // Check if there's a stablecoin pool we can reference
      const usdtAddr = config.TOKENS?.USDT
      if (usdtAddr) {
        const agniFactory = new ethers.Contract(
          config.AGNI.FACTORY,
          [{ "inputs": [{"type":"address"},{"type":"address"},{"type":"uint24"}], "name": "getPool", "outputs": [{"type":"address"}], "stateMutability": "view", "type": "function" }],
          provider
        )
        // Try fee tiers
        for (const fee of [500, 3000, 100]) {
          try {
            const poolAddr = await agniFactory.getPool(token1.address, usdtAddr, fee)
            if (poolAddr && poolAddr !== ethers.ZeroAddress) {
              const pool = new ethers.Contract(poolAddr, IAgniV3Pool, provider)
              const [sp] = await pool.slot0()
              const pt0 = (await pool.token0()).toLowerCase()
              const sq = Big(sp.toString())
              const rp = sq.mul(sq).div(Big(2).pow(192))
              // USDT has 6 decimals, WETH has 18
              if (token1.address.toLowerCase() === pt0) {
                // rawPrice = USDT per WETH in raw, scale by 18-6=12
                token1USD = Number(rp.mul(Big(10).pow(12)))
              } else {
                token1USD = Number(Big(1).div(rp).mul(Big(10).pow(12)))
              }
              // Sanity check
              if (token1USD < 100 || token1USD > 100000) {
                // Probably wrong decimals, revert
                token1USD = WETH_USD_FALLBACK
              }
              break
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  } else if (["USDT", "USDC", "USDe", "DAI"].includes(t1sym)) {
    token1USD = 1.0
  } else {
    // Unknown token1, try rough estimate
    token1USD = 1.0
    console.log(`  ⚠️ Cannot determine ${t1sym} USD price, assuming $1`)
  }

  // token0 price = (1 / rate) * token1USD
  // rate is how many token0 per 1 token1
  // so token0 price = token1USD / rate
  const token0USD = Number(Big(token1USD).div(rateToken0PerToken1))

  console.log(`  ${token1.symbol} price: ~$${token1USD.toFixed(2)}`)

  // Sanity check
  if (token0USD < 0.001 || token0USD > 1000000) {
    console.log(`  ⚠️  WARNING: ${token0.symbol} price $${token0USD.toFixed(6)} looks wrong!`)
    console.log(`     rateToken0PerToken1 = ${rateToken0PerToken1.toFixed(6)}`)
    console.log(`     rawV3 = ${rawV3.toFixed(12)}`)
    console.log(`     Attempting fallback...`)
    
    // Fallback: if token1 is WETH, WMNT is ~$0.50-1.00
    if (t1sym === "WETH" || t1sym === "ETH") {
      // rateToken0PerToken1 should be ~3000-4000 for WMNT/WETH
      // If it's < 1, it's inverted
      const testRate = Number(rateToken0PerToken1)
      if (testRate < 1) {
        console.log(`     Rate < 1 → likely inverted. Using 1/rate.`)
        return token1USD * testRate  // token0USD = WETH_USD × (WETH_per_WMNT)
      }
    }
  }

  return token0USD
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function parseArgs() {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pair" && argv[i + 1]) args.pair = argv[i + 1]
    if (argv[i] === "--repeat" && argv[i + 1]) args.repeat = parseInt(argv[i + 1])
    if (argv[i] === "--delay" && argv[i + 1]) args.delay = parseInt(argv[i + 1])
  }
  return args
}

main().catch(err => {
  console.error("\n⛔ Fatal error:", err)
  process.exit(1)
})
