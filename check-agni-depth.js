/**
 * check-agni-depth.js
 * 
 * Checks ALL Agni fee tiers for WMNT/WETH and reports liquidity at each.
 * Also checks key intermediary pools (WMNT/USDT, WETH/USDT) for routing.
 */

require("dotenv").config()
const ethers = require("ethers")
const config = require("./config.json")

const RPC = config.RPC.HTTP
const IERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC)

  const agniFactory = new ethers.Contract(
    config.AGNI.FACTORY,
    [{ inputs: [{type:"address"},{type:"address"},{type:"uint24"}], name: "getPool", outputs: [{type:"address"}], stateMutability: "view", type: "function" }],
    provider
  )

  const WMNT = config.TOKENS.WMNT
  const WETH = config.TOKENS.WETH
  const USDT = config.TOKENS.USDT
  const USDC = config.TOKENS.USDC
  const USDe = config.TOKENS.USDe
  const cmETH = config.TOKENS.cmETH

  const feeTiers = [100, 500, 2500, 3000, 10000]

  console.log("═══════════════════════════════════════")
  console.log("  Agni Pool Depth Scanner")
  console.log("═══════════════════════════════════════\n")

  // Check all WMNT/WETH tiers
  console.log("── WMNT/WETH pools (all fee tiers) ──")
  for (const fee of feeTiers) {
    try {
      const pool = await agniFactory.getPool(WMNT, WETH, fee)
      if (!pool || pool === ethers.ZeroAddress) {
        console.log(`  Fee ${fee} (${fee/10000}%): no pool`)
        continue
      }
      const wmntBal = await new ethers.Contract(WMNT, IERC20_ABI, provider).balanceOf(pool)
      const wethBal = await new ethers.Contract(WETH, IERC20_ABI, provider).balanceOf(pool)
      const wmntF = Number(ethers.formatUnits(wmntBal, 18))
      const wethF = Number(ethers.formatUnits(wethBal, 18))
      console.log(`  Fee ${fee} (${fee/10000}%): ${pool}`)
      console.log(`    WMNT: ${wmntF.toFixed(1)} (~$${(wmntF * 0.6).toFixed(0)})`)
      console.log(`    WETH: ${wethF.toFixed(4)} (~$${(wethF * 2700).toFixed(0)})`)
      console.log()
    } catch (e) {
      console.log(`  Fee ${fee}: error — ${e.message.slice(0, 60)}`)
    }
  }

  // Check intermediary routing pools
  const routes = [
    ["WMNT/USDT", WMNT, USDT, 18, 6],
    ["WETH/USDT", WETH, USDT, 18, 6],
    ["WMNT/USDe", WMNT, USDe, 18, 18],
    ["WETH/USDe", WETH, USDe, 18, 18],
    ["WMNT/USDC", WMNT, USDC, 18, 6],
    ["WETH/USDC", WETH, USDC, 18, 6],
    ["WMNT/cmETH", WMNT, cmETH, 18, 18],
    ["WETH/cmETH", WETH, cmETH, 18, 18],
  ]

  console.log("── Intermediary routing pools (deepest fee tier) ──")
  for (const [name, tokenA, tokenB, decA, decB] of routes) {
    let bestPool = null, bestTVL = 0, bestFee = 0
    for (const fee of feeTiers) {
      try {
        const pool = await agniFactory.getPool(tokenA, tokenB, fee)
        if (!pool || pool === ethers.ZeroAddress) continue
        const balA = Number(ethers.formatUnits(await new ethers.Contract(tokenA, IERC20_ABI, provider).balanceOf(pool), decA))
        const balB = Number(ethers.formatUnits(await new ethers.Contract(tokenB, IERC20_ABI, provider).balanceOf(pool), decB))
        // Rough TVL estimate
        const tvl = balA * 0.6 + balB * 2700 // crude
        if (tvl > bestTVL) {
          bestTVL = tvl
          bestPool = pool
          bestFee = fee
        }
      } catch (_) {}
    }
    if (bestPool) {
      const balA = Number(ethers.formatUnits(await new ethers.Contract(tokenA, IERC20_ABI, provider).balanceOf(bestPool), decA))
      const balB = Number(ethers.formatUnits(await new ethers.Contract(tokenB, IERC20_ABI, provider).balanceOf(bestPool), decB))
      console.log(`  ${name} (fee=${bestFee}): ${balA.toFixed(2)} / ${balB.toFixed(4)}  [${bestPool.slice(0,10)}...]`)
    } else {
      console.log(`  ${name}: no pool found`)
    }
  }

  // Also check MM WMNT/WETH depth at current state
  console.log("\n── Merchant Moe WMNT/WETH depth ──")
  const mmFactory = new ethers.Contract(
    config.MERCHANTMOE.FACTORY,
    [{inputs:[{type:"address"},{type:"address"},{type:"uint256"}],name:"getLBPairInformation",outputs:[{components:[{type:"uint16",name:"binStep"},{type:"address",name:"LBPair"},{type:"bool",name:"createdByOwner"},{type:"bool",name:"ignoredForRouting"}],type:"tuple"}],stateMutability:"view",type:"function"}],
    provider
  )
  const mmInfo = await mmFactory.getLBPairInformation(WMNT, WETH, 10)
  const mmPool = mmInfo.LBPair
  const mmWmnt = Number(ethers.formatUnits(await new ethers.Contract(WMNT, IERC20_ABI, provider).balanceOf(mmPool), 18))
  const mmWeth = Number(ethers.formatUnits(await new ethers.Contract(WETH, IERC20_ABI, provider).balanceOf(mmPool), 18))
  console.log(`  Pool: ${mmPool}`)
  console.log(`  WMNT: ${mmWmnt.toFixed(1)} (~$${(mmWmnt * 0.6).toFixed(0)})`)
  console.log(`  WETH: ${mmWeth.toFixed(4)} (~$${(mmWeth * 2700).toFixed(0)})`)
  console.log(`  Total: ~$${((mmWmnt * 0.6) + (mmWeth * 2700)).toFixed(0)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
