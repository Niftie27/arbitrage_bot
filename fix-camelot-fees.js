/**
 * fix-camelot-fees.js
 * 
 * Find the correct fee parameter for each pair on Camelot quoter.
 * Algebra pools don't have fee tiers, but the V3-compatible quoter
 * needs SOME fee value to route correctly. This script brute-forces it.
 */

require("dotenv").config()
const ethers = require("ethers")

const RPC = process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc"
const CAMELOT_QUOTER = "0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1"

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

const TOKENS = {
  WETH:   { addr: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", dec: 18, sym: "WETH" },
  USDC:   { addr: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", dec: 6,  sym: "USDC" },
  PENDLE: { addr: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", dec: 18, sym: "PENDLE" },
  GNS:    { addr: "0x18c11FD286C5EC11c3b683Caa813B77f5163A122", dec: 18, sym: "GNS" },
  MAGIC:  { addr: "0x539bdE0d7Dbd336b79148AA742883198BBF60342", dec: 18, sym: "MAGIC" },
  LINK:   { addr: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", dec: 18, sym: "LINK" },
  ARB:    { addr: "0x912CE59144191C1204E64559FE8253a0e49E6548", dec: 18, sym: "ARB" },
}

const PAIRS = [
  { name: "WETH/PENDLE", tokenIn: TOKENS.WETH, tokenOut: TOKENS.PENDLE, amount: ethers.parseUnits("0.5", 18) },
  { name: "WETH/GNS",    tokenIn: TOKENS.WETH, tokenOut: TOKENS.GNS,    amount: ethers.parseUnits("0.5", 18) },
  { name: "WETH/MAGIC",  tokenIn: TOKENS.WETH, tokenOut: TOKENS.MAGIC,  amount: ethers.parseUnits("0.5", 18) },
  { name: "WETH/LINK",   tokenIn: TOKENS.WETH, tokenOut: TOKENS.LINK,   amount: ethers.parseUnits("0.5", 18) },
  { name: "WETH/ARB",    tokenIn: TOKENS.WETH, tokenOut: TOKENS.ARB,    amount: ethers.parseUnits("0.01", 18) },
  { name: "USDC/ARB",    tokenIn: TOKENS.USDC, tokenOut: TOKENS.ARB,    amount: ethers.parseUnits("100", 6) },
]

// Fee values to try — covers all standard V3 tiers, Algebra dynamic fees we saw, and edge cases
const FEES_TO_TRY = [0, 100, 249, 250, 500, 1000, 1157, 2500, 3000, 3406, 5000, 10000]

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const quoter = new ethers.Contract(CAMELOT_QUOTER, V3_QUOTER_ABI, provider)
  const block = await provider.getBlockNumber()

  console.log(`\n═══ Camelot Fee Routing Diagnostic ═══`)
  console.log(`Block: ${block}`)
  console.log(`Quoter: ${CAMELOT_QUOTER}\n`)

  for (const pair of PAIRS) {
    console.log(`── ${pair.name} ──`)
    console.log(`  Input: ${ethers.formatUnits(pair.amount, pair.tokenIn.dec)} ${pair.tokenIn.sym}`)

    let bestFee = null
    let bestOut = 0n

    for (const fee of FEES_TO_TRY) {
      try {
        const result = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenIn.addr,
          tokenOut: pair.tokenOut.addr,
          amountIn: pair.amount,
          fee,
          sqrtPriceLimitX96: 0n
        })
        const outFormatted = Number(ethers.formatUnits(result[0], pair.tokenOut.dec)).toFixed(4)
        const marker = result[0] > bestOut ? " ← BEST" : ""
        console.log(`  fee=${String(fee).padEnd(5)} → ${outFormatted} ${pair.tokenOut.sym}${marker}`)
        if (result[0] > bestOut) {
          bestOut = result[0]
          bestFee = fee
        }
      } catch (e) {
        const msg = e.message.includes("Unexpected error") ? "Unexpected error" :
                    e.message.includes("require(false)") ? "revert (no pool?)" :
                    e.message.slice(0, 40)
        console.log(`  fee=${String(fee).padEnd(5)} → ❌ ${msg}`)
      }
      await new Promise(r => setTimeout(r, 150))
    }

    if (bestFee !== null) {
      console.log(`  ✅ BEST FEE: ${bestFee} → ${Number(ethers.formatUnits(bestOut, pair.tokenOut.dec)).toFixed(4)} ${pair.tokenOut.sym}`)
    } else {
      console.log(`  ❌ NO FEE WORKS for this pair`)
    }
    console.log()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
