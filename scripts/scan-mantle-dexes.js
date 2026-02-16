/**
 * scan-mantle-dexes.js
 * 
 * Scans ALL known Mantle V3/V2 DEXes for WMNT/WETH pool depth.
 * If any DEX has meaningful liquidity, the 30-day proven edge is executable.
 */

require("dotenv").config()
const ethers = require("ethers")
const config = require("../config.json")

const RPC = config.RPC.HTTP
const WMNT = config.TOKENS.WMNT
const WETH = config.TOKENS.WETH

const IERC20 = ["function balanceOf(address) view returns (uint256)"]
const V3_FACTORY_ABI = [{ inputs: [{type:"address"},{type:"address"},{type:"uint24"}], name: "getPool", outputs: [{type:"address"}], stateMutability: "view", type: "function" }]

// Known Mantle DEX factories
const DEXES = [
  {
    name: "Agni Finance",
    type: "V3",
    factory: "0x25780dc8Fc3cfBd75F33bFdaB65e969b603b2035",
    fees: [100, 500, 2500, 3000, 10000],
    quoter: "0xc4aaDc921e1cdb66c5300Bc158a313292923C0cb"
  },
  {
    name: "FusionX V3",
    type: "V3",
    factory: "0x530d2766D1988CC1c000C8b7d00334c14B69AD71",
    fees: [100, 500, 2500, 3000, 10000],
    quoter: "0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c"
  },
  {
    name: "iZiSwap",
    type: "iZi",
    factory: "0x45e5F26451CDB01B0fA1f8582E0aAD9A6F27C218",
    // iZiSwap uses different fee encoding
    fees: [400, 2000, 10000],
    factoryMethod: "pool" // different method name
  },
  {
    name: "Butter.xyz",
    type: "V3",
    factory: "0xeaC8B2C2DCE327855F3c8F1De1aC54a532B24EbF",
    fees: [100, 500, 3000, 10000]
  },
  {
    name: "Cleopatra V1 (Solidly)",
    type: "V2",
    factory: "0xAAA16c016BF556fcD620328f0759252E29b1AB57",
    // Solidly has stable/volatile pools
    pairMethod: "getPair"
  },
  {
    name: "Merchant Moe LB",
    type: "LB",
    factory: config.MERCHANTMOE.FACTORY,
    binSteps: [1, 2, 5, 10, 15, 20, 25, 50, 100]
  }
]

const LB_FACTORY_ABI = [{
  inputs:[{type:"address"},{type:"address"},{type:"uint256"}],
  name:"getLBPairInformation",
  outputs:[{components:[{type:"uint16",name:"binStep"},{type:"address",name:"LBPair"},{type:"bool"},{type:"bool"}],type:"tuple"}],
  stateMutability:"view",type:"function"
}]

const V2_FACTORY_ABI = [
  { inputs:[{type:"address"},{type:"address"},{type:"bool"}], name:"getPair", outputs:[{type:"address"}], stateMutability:"view", type:"function" },
  { inputs:[{type:"address"},{type:"address"}], name:"getPair", outputs:[{type:"address"}], stateMutability:"view", type:"function" }
]

const IZI_FACTORY_ABI = [{
  inputs:[{type:"address"},{type:"address"},{type:"uint24"}],
  name:"pool",
  outputs:[{type:"address"}],
  stateMutability:"view",type:"function"
}]

// Also scan for other deep pairs
const EXTRA_PAIRS = [
  { name: "WMNT/USDT", tokenA: WMNT, tokenB: config.TOKENS.USDT, decA: 18, decB: 6 },
  { name: "WETH/USDT", tokenA: WETH, tokenB: config.TOKENS.USDT, decA: 18, decB: 6 },
  { name: "cmETH/WETH", tokenA: config.TOKENS.cmETH, tokenB: WETH, decA: 18, decB: 18 },
  { name: "USDe/WMNT", tokenA: config.TOKENS.USDe, tokenB: WMNT, decA: 18, decB: 18 },
]

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const wmntC = new ethers.Contract(WMNT, IERC20, provider)
  const wethC = new ethers.Contract(WETH, IERC20, provider)

  console.log("═══════════════════════════════════════════════")
  console.log("  Mantle Multi-DEX WMNT/WETH Liquidity Scanner")
  console.log("═══════════════════════════════════════════════\n")

  const results = []

  for (const dex of DEXES) {
    console.log(`── ${dex.name} (${dex.type}) ──`)

    try {
      if (dex.type === "V3") {
        const factory = new ethers.Contract(dex.factory, V3_FACTORY_ABI, provider)
        for (const fee of dex.fees) {
          try {
            const pool = await factory.getPool(WMNT, WETH, fee)
            if (!pool || pool === ethers.ZeroAddress) continue
            const wmntBal = Number(ethers.formatUnits(await wmntC.balanceOf(pool), 18))
            const wethBal = Number(ethers.formatUnits(await wethC.balanceOf(pool), 18))
            const tvl = wmntBal * 0.6 + wethBal * 2700
            console.log(`  Fee ${fee} (${fee/10000}%): ${pool}`)
            console.log(`    WMNT: ${wmntBal.toFixed(1)} (~$${(wmntBal*0.6).toFixed(0)}) | WETH: ${wethBal.toFixed(4)} (~$${(wethBal*2700).toFixed(0)}) | TVL: ~$${tvl.toFixed(0)}`)
            results.push({ dex: dex.name, fee, pool, wmntBal, wethBal, tvl, feePct: fee/10000 })
          } catch (e) {
            // pool doesn't exist at this fee
          }
        }
      } else if (dex.type === "iZi") {
        const factory = new ethers.Contract(dex.factory, IZI_FACTORY_ABI, provider)
        for (const fee of dex.fees) {
          try {
            const pool = await factory.pool(WMNT, WETH, fee)
            if (!pool || pool === ethers.ZeroAddress) continue
            const wmntBal = Number(ethers.formatUnits(await wmntC.balanceOf(pool), 18))
            const wethBal = Number(ethers.formatUnits(await wethC.balanceOf(pool), 18))
            const tvl = wmntBal * 0.6 + wethBal * 2700
            console.log(`  Fee ${fee} (${fee/10000}%): ${pool}`)
            console.log(`    WMNT: ${wmntBal.toFixed(1)} (~$${(wmntBal*0.6).toFixed(0)}) | WETH: ${wethBal.toFixed(4)} (~$${(wethBal*2700).toFixed(0)}) | TVL: ~$${tvl.toFixed(0)}`)
            results.push({ dex: dex.name, fee, pool, wmntBal, wethBal, tvl, feePct: fee/10000 })
          } catch (e) {}
        }
      } else if (dex.type === "LB") {
        const factory = new ethers.Contract(dex.factory, LB_FACTORY_ABI, provider)
        for (const bs of dex.binSteps) {
          try {
            const info = await factory.getLBPairInformation(WMNT, WETH, bs)
            if (!info.LBPair || info.LBPair === ethers.ZeroAddress) continue
            const wmntBal = Number(ethers.formatUnits(await wmntC.balanceOf(info.LBPair), 18))
            const wethBal = Number(ethers.formatUnits(await wethC.balanceOf(info.LBPair), 18))
            const tvl = wmntBal * 0.6 + wethBal * 2700
            console.log(`  BinStep ${bs} (~${bs/100}% fee): ${info.LBPair}`)
            console.log(`    WMNT: ${wmntBal.toFixed(1)} (~$${(wmntBal*0.6).toFixed(0)}) | WETH: ${wethBal.toFixed(4)} (~$${(wethBal*2700).toFixed(0)}) | TVL: ~$${tvl.toFixed(0)}`)
            results.push({ dex: dex.name, fee: bs, pool: info.LBPair, wmntBal, wethBal, tvl, feePct: bs/100 })
          } catch (e) {}
        }
      } else if (dex.type === "V2") {
        const factory = new ethers.Contract(dex.factory, V2_FACTORY_ABI, provider)
        for (const stable of [true, false]) {
          try {
            let pool
            try {
              pool = await factory.getPair(WMNT, WETH, stable)
            } catch {
              pool = await factory.getPair(WMNT, WETH)
            }
            if (!pool || pool === ethers.ZeroAddress) continue
            const wmntBal = Number(ethers.formatUnits(await wmntC.balanceOf(pool), 18))
            const wethBal = Number(ethers.formatUnits(await wethC.balanceOf(pool), 18))
            const tvl = wmntBal * 0.6 + wethBal * 2700
            console.log(`  ${stable ? 'Stable' : 'Volatile'}: ${pool}`)
            console.log(`    WMNT: ${wmntBal.toFixed(1)} (~$${(wmntBal*0.6).toFixed(0)}) | WETH: ${wethBal.toFixed(4)} (~$${(wethBal*2700).toFixed(0)}) | TVL: ~$${tvl.toFixed(0)}`)
            results.push({ dex: dex.name, fee: stable ? 'stable' : 'volatile', pool, wmntBal, wethBal, tvl, feePct: 0.3 })
          } catch (e) {}
        }
      }
    } catch (e) {
      console.log(`  Error: ${e.message.slice(0, 80)}`)
    }
    console.log()
  }

  // Rank by TVL
  console.log("═══════════════════════════════════════════════")
  console.log("  WMNT/WETH POOLS — RANKED BY TVL")
  console.log("═══════════════════════════════════════════════\n")

  results.sort((a, b) => b.tvl - a.tvl)
  for (const r of results) {
    const viable = r.tvl > 10000 ? "✅" : r.tvl > 2000 ? "🟡" : "❌"
    console.log(`  ${viable} $${r.tvl.toFixed(0).padStart(7)} | ${r.dex.padEnd(20)} | fee=${String(r.feePct).padEnd(5)}% | WMNT: ${r.wmntBal.toFixed(0).padStart(7)} | WETH: ${r.wethBal.toFixed(3).padStart(8)}`)
  }

  // Check key extra pairs on FusionX (most likely to have deep pools)
  console.log("\n═══════════════════════════════════════════════")
  console.log("  FUSIONX — KEY PAIR DEPTH CHECK")
  console.log("═══════════════════════════════════════════════\n")

  const fusionFactory = new ethers.Contract("0x530d2766D1988CC1c000C8b7d00334c14B69AD71", V3_FACTORY_ABI, provider)
  for (const pair of EXTRA_PAIRS) {
    for (const fee of [100, 500, 2500, 3000, 10000]) {
      try {
        const pool = await fusionFactory.getPool(pair.tokenA, pair.tokenB, fee)
        if (!pool || pool === ethers.ZeroAddress) continue
        const balA = Number(ethers.formatUnits(await new ethers.Contract(pair.tokenA, IERC20, provider).balanceOf(pool), pair.decA))
        const balB = Number(ethers.formatUnits(await new ethers.Contract(pair.tokenB, IERC20, provider).balanceOf(pool), pair.decB))
        console.log(`  ${pair.name} (fee=${fee}): ${balA.toFixed(2)} / ${balB.toFixed(4)} [${pool.slice(0,10)}...]`)
      } catch (e) {}
    }
  }

  console.log("\n═══════════════════════════════════════════════")
  console.log("  VERDICT")
  console.log("═══════════════════════════════════════════════\n")

  const viable = results.filter(r => r.tvl > 10000 && r.dex !== "Merchant Moe LB")
  if (viable.length > 0) {
    console.log("  ✅ FOUND VIABLE WMNT/WETH POOLS!")
    console.log("  These can potentially replace Agni for the proven 0.23% edge:\n")
    for (const v of viable) {
      console.log(`     ${v.dex} (fee=${v.feePct}%) — TVL ~$${v.tvl.toFixed(0)}`)
    }
    console.log("\n  → Run slippage simulator against these pools next")
  } else {
    console.log("  ❌ No deep WMNT/WETH pool found outside Merchant Moe")
    console.log("  → WMNT/WETH arb on Mantle is structurally non-viable")
    console.log("  → Consider: other chains, or multi-pair micro-edge strategy")
  }
}

main().catch(e => { console.error(e); process.exit(1) })
