// ── verify-addresses.js ─────────────────────────────────
// Checks every token, factory, and pool in config.json
// Scans for correct binSteps/fee tiers if configured ones fail
// Run: node verify-addresses.js

const ethers = require("ethers")
const config = require("./config.json")

const provider = new ethers.JsonRpcProvider(config.RPC.HTTP)

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
]

const LB_FACTORY_ABI = [
  "function getLBPairInformation(address tokenA, address tokenB, uint256 binStep) view returns (tuple(uint16 binStep, address LBPair, bool createdByOwner, bool ignoredForRouting))"
]

const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"
]

const LB_PAIR_ABI = [
  "function getActiveId() view returns (uint24)",
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getReserves() view returns (uint128, uint128)"
]

const V3_POOL_ABI = [
  "function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)"
]

// BinSteps to scan on Merchant Moe
const BIN_STEPS = [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100]
// Fee tiers to scan on Agni
const FEE_TIERS = [100, 500, 2500, 3000, 10000]

let failures = 0

async function main() {
  console.log("═══════════════════════════════════════════")
  console.log("  Mantle Config Verification")
  console.log("═══════════════════════════════════════════\n")

  // ── 1. Check all tokens ───────────────────────────────
  console.log("── TOKENS ─────────────────────────────────")
  const tokenInfo = {}
  for (const [name, addr] of Object.entries(config.TOKENS)) {
    try {
      const c = new ethers.Contract(ethers.getAddress(addr), ERC20_ABI, provider)
      const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()])
      tokenInfo[addr.toLowerCase()] = { symbol, decimals: Number(decimals) }
      console.log(`  ✅ ${name.padEnd(6)} | ${symbol.padEnd(6)} | ${decimals} dec | ${ethers.getAddress(addr)}`)
    } catch (err) {
      failures++
      console.log(`  ❌ ${name.padEnd(6)} | ${addr} | ${err.message.slice(0, 60)}`)
    }
  }

  // ── 2. Check factories ────────────────────────────────
  console.log("\n── FACTORIES ──────────────────────────────")
  const mmFactory = new ethers.Contract(ethers.getAddress(config.MERCHANTMOE.FACTORY), LB_FACTORY_ABI, provider)
  const agniFactory = new ethers.Contract(ethers.getAddress(config.AGNI.FACTORY), V3_FACTORY_ABI, provider)

  try {
    // Quick smoke test with known pair
    await mmFactory.getLBPairInformation(config.TOKENS.WMNT, config.TOKENS.WETH, 10)
    console.log(`  ✅ Merchant Moe Factory: ${ethers.getAddress(config.MERCHANTMOE.FACTORY)}`)
  } catch (err) {
    failures++
    console.log(`  ❌ Merchant Moe Factory: ${err.message.slice(0, 80)}`)
  }

  try {
    await agniFactory.getPool(config.TOKENS.WMNT, config.TOKENS.WETH, 500)
    console.log(`  ✅ Agni Factory: ${ethers.getAddress(config.AGNI.FACTORY)}`)
  } catch (err) {
    failures++
    console.log(`  ❌ Agni Factory: ${err.message.slice(0, 80)}`)
  }

  // ── 3. Check each pair ────────────────────────────────
  console.log("\n── PAIRS ──────────────────────────────────")

  for (const pair of config.PAIRS) {
    console.log(`\n┌─ ${pair.name} [${pair.tier}] (${pair.mode}) ───────────`)

    const t0 = pair.ARB_FOR.toLowerCase()
    const t1 = pair.ARB_AGAINST.toLowerCase()
    const t0Info = tokenInfo[t0]
    const t1Info = tokenInfo[t1]

    if (!t0Info || !t1Info) {
      failures++
      console.log(`│  ❌ Token addresses not resolved — skipping`)
      continue
    }

    console.log(`│  Tokens: ${t0Info.symbol} (${t0Info.decimals}d) / ${t1Info.symbol} (${t1Info.decimals}d)`)

    // ── Merchant Moe ──
    let mmFound = false
    try {
      const info = await mmFactory.getLBPairInformation(
        ethers.getAddress(pair.ARB_FOR),
        ethers.getAddress(pair.ARB_AGAINST),
        pair.MM_BIN_STEP
      )
      if (info.LBPair !== ethers.ZeroAddress) {
        mmFound = true
        const pool = new ethers.Contract(info.LBPair, LB_PAIR_ABI, provider)
        const [activeId, [resX, resY]] = await Promise.all([
          pool.getActiveId(),
          pool.getReserves()
        ])
        const tokenX = await pool.getTokenX()
        
        // Show reserves in human-readable
        let res0, res1
        if (tokenX.toLowerCase() === t0) {
          res0 = ethers.formatUnits(resX, t0Info.decimals)
          res1 = ethers.formatUnits(resY, t1Info.decimals)
        } else {
          res0 = ethers.formatUnits(resY, t0Info.decimals)
          res1 = ethers.formatUnits(resX, t1Info.decimals)
        }

        console.log(`│  ✅ MM  binStep=${pair.MM_BIN_STEP} | ${info.LBPair}`)
        console.log(`│     activeId=${activeId} | ${t0Info.symbol}=${Number(res0).toFixed(2)} | ${t1Info.symbol}=${Number(res1).toFixed(2)}`)
      }
    } catch (err) {
      // will handle below
    }

    if (!mmFound) {
      console.log(`│  ❌ MM  binStep=${pair.MM_BIN_STEP} — NOT FOUND. Scanning...`)
      let anyFound = false
      for (const step of BIN_STEPS) {
        try {
          const info = await mmFactory.getLBPairInformation(
            ethers.getAddress(pair.ARB_FOR),
            ethers.getAddress(pair.ARB_AGAINST),
            step
          )
          if (info.LBPair !== ethers.ZeroAddress) {
            anyFound = true
            console.log(`│     🔍 FOUND binStep=${step} → ${info.LBPair}`)
          }
        } catch (_) {}
      }
      if (!anyFound) console.log(`│     🔍 No MM pools found for this pair`)
      failures++
    }

    // ── Agni Finance ──
    let agniFound = false
    try {
      const poolAddr = await agniFactory.getPool(
        ethers.getAddress(pair.ARB_FOR),
        ethers.getAddress(pair.ARB_AGAINST),
        pair.AGNI_FEE
      )
      if (poolAddr !== ethers.ZeroAddress) {
        agniFound = true
        const pool = new ethers.Contract(poolAddr, V3_POOL_ABI, provider)
        const [slot0Result, liq] = await Promise.all([
          pool.slot0(),
          pool.liquidity()
        ])
        
        // Get token balances at pool
        const bal0Contract = new ethers.Contract(ethers.getAddress(pair.ARB_FOR), ERC20_ABI, provider)
        const bal1Contract = new ethers.Contract(ethers.getAddress(pair.ARB_AGAINST), ERC20_ABI, provider)
        const [b0, b1] = await Promise.all([
          bal0Contract.balanceOf(poolAddr),
          bal1Contract.balanceOf(poolAddr)
        ])
        
        const bal0 = ethers.formatUnits(b0, t0Info.decimals)
        const bal1 = ethers.formatUnits(b1, t1Info.decimals)

        console.log(`│  ✅ Agni fee=${pair.AGNI_FEE} | ${poolAddr}`)
        console.log(`│     sqrtPrice=${slot0Result[0].toString().slice(0, 20)}... | liq=${liq.toString().slice(0, 15)}`)
        console.log(`│     ${t0Info.symbol}=${Number(bal0).toFixed(4)} | ${t1Info.symbol}=${Number(bal1).toFixed(4)}`)
      }
    } catch (err) {
      // will handle below
    }

    if (!agniFound) {
      console.log(`│  ❌ Agni fee=${pair.AGNI_FEE} — NOT FOUND. Scanning...`)
      let anyFound = false
      for (const fee of FEE_TIERS) {
        try {
          const poolAddr = await agniFactory.getPool(
            ethers.getAddress(pair.ARB_FOR),
            ethers.getAddress(pair.ARB_AGAINST),
            fee
          )
          if (poolAddr !== ethers.ZeroAddress) {
            anyFound = true
            console.log(`│     🔍 FOUND fee=${fee} → ${poolAddr}`)
          }
        } catch (_) {}
      }
      if (!anyFound) console.log(`│     🔍 No Agni pools found for this pair`)
      failures++
    }

    console.log(`└──────────────────────────────────────────`)
  }

  // ── Summary ───────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════")
  if (failures === 0) {
    console.log("  ✅ ALL CHECKS PASSED — ready to run bot")
  } else {
    console.log(`  ⚠️  ${failures} ISSUE(S) — fix config before running bot`)
    console.log("  Update binSteps/fees to match 🔍 FOUND values above")
  }
  console.log("═══════════════════════════════════════════\n")
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
