/**
 * check-historical-depth.js
 * 
 * Answers ONE question: Was the Agni WMNT/WETH pool always empty,
 * or did it recently drain?
 * 
 * If always empty → 30-day spread was never executable → move on
 * If recently drained → opportunity existed, may return → investigate
 */

require("dotenv").config()
const ethers = require("ethers")
const config = require("./config.json")

const RPC = config.RPC.HTTP
const AGNI_POOL = "0x54169896d28dec0FFABE3B16f90f71323774949f" // WMNT/WETH fee=500
const MM_POOL = "0x1606C79bE3EBD70D8d40bAc6287e23005CfBefA2"
const WMNT = config.TOKENS.WMNT
const WETH = config.TOKENS.WETH

const IERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"])

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const currentBlock = await provider.getBlockNumber()

  console.log("══════════════════════════════════════════")
  console.log("  Historical Pool Depth Check")
  console.log("  Was Agni WMNT/WETH always empty?")
  console.log("══════════════════════════════════════════\n")

  // Sample every ~3 days over last 30 days
  // Mantle ~2s/block → 1 day ≈ 43200 blocks
  const BLOCKS_PER_DAY = 43200
  const checkpoints = []
  
  for (let daysAgo = 0; daysAgo <= 30; daysAgo += 3) {
    checkpoints.push({
      label: daysAgo === 0 ? "NOW" : `${daysAgo}d ago`,
      block: currentBlock - (daysAgo * BLOCKS_PER_DAY)
    })
  }

  // Also check key FusionX pool
  const FUSIONX_POOL = "0xD3d3127D9654f806370da592eb292eA0a347f0e3" // fee=2500

  console.log("  Block       | When     | Agni WMNT | Agni WETH | Agni TVL  | MM WMNT   | MM WETH  | MM TVL    | FusionX TVL")
  console.log("  " + "-".repeat(115))

  for (const cp of checkpoints) {
    try {
      const wmntContract = new ethers.Contract(WMNT, ["function balanceOf(address) view returns (uint256)"], provider)
      const wethContract = new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], provider)

      // Agni pool
      const agniWmnt = Number(ethers.formatUnits(
        await wmntContract.balanceOf(AGNI_POOL, { blockTag: cp.block }), 18
      ))
      const agniWeth = Number(ethers.formatUnits(
        await wethContract.balanceOf(AGNI_POOL, { blockTag: cp.block }), 18
      ))
      const agniTVL = agniWmnt * 0.6 + agniWeth * 2700

      // MM pool
      const mmWmnt = Number(ethers.formatUnits(
        await wmntContract.balanceOf(MM_POOL, { blockTag: cp.block }), 18
      ))
      const mmWeth = Number(ethers.formatUnits(
        await wethContract.balanceOf(MM_POOL, { blockTag: cp.block }), 18
      ))
      const mmTVL = mmWmnt * 0.6 + mmWeth * 2700

      // FusionX pool
      let fxTVL = 0
      try {
        const fxWmnt = Number(ethers.formatUnits(
          await wmntContract.balanceOf(FUSIONX_POOL, { blockTag: cp.block }), 18
        ))
        const fxWeth = Number(ethers.formatUnits(
          await wethContract.balanceOf(FUSIONX_POOL, { blockTag: cp.block }), 18
        ))
        fxTVL = fxWmnt * 0.6 + fxWeth * 2700
      } catch (_) {}

      const pad = (s, n) => String(s).padStart(n)
      console.log(
        `  ${pad(cp.block, 10)} | ${cp.label.padEnd(8)}` +
        ` | ${pad(agniWmnt.toFixed(0), 9)}` +
        ` | ${pad(agniWeth.toFixed(3), 9)}` +
        ` | $${pad(agniTVL.toFixed(0), 7)}` +
        ` | ${pad(mmWmnt.toFixed(0), 9)}` +
        ` | ${pad(mmWeth.toFixed(3), 8)}` +
        ` | $${pad(mmTVL.toFixed(0), 8)}` +
        ` | $${pad(fxTVL.toFixed(0), 7)}`
      )

      // Small delay to avoid rate limit
      await new Promise(r => setTimeout(r, 500))
    } catch (e) {
      console.log(`  ${cp.block} | ${cp.label.padEnd(8)} | ERROR: ${e.message.slice(0, 50)}`)
    }
  }

  console.log()
}

main().catch(e => { console.error(e); process.exit(1) })
