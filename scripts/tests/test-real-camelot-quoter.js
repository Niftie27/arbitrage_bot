/**
 * test-real-camelot-quoter.js
 * 
 * Tests the OFFICIAL Camelot Algebra quoter: 0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E
 * From: https://docs.algebra.finance/algebra-integral-documentation/overview-faq/partners/algebra-v1.9/camelot
 * 
 * Algebra quoter does NOT use fee parameter. Routes by factory + pair.
 */

require("dotenv").config()
const ethers = require("ethers")

const RPC = process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc"
const REAL_CAMELOT_QUOTER = "0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E"

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
  { name: "WETH→PENDLE", tIn: TOKENS.WETH, tOut: TOKENS.PENDLE, amt: ethers.parseUnits("0.5", 18) },
  { name: "WETH→GNS",    tIn: TOKENS.WETH, tOut: TOKENS.GNS,    amt: ethers.parseUnits("0.5", 18) },
  { name: "WETH→MAGIC",  tIn: TOKENS.WETH, tOut: TOKENS.MAGIC,  amt: ethers.parseUnits("0.5", 18) },
  { name: "WETH→LINK",   tIn: TOKENS.WETH, tOut: TOKENS.LINK,   amt: ethers.parseUnits("0.5", 18) },
  { name: "WETH→ARB",    tIn: TOKENS.WETH, tOut: TOKENS.ARB,    amt: ethers.parseUnits("0.5", 18) },
  { name: "USDC→ARB",    tIn: TOKENS.USDC, tOut: TOKENS.ARB,    amt: ethers.parseUnits("500", 6) },
]

// Algebra QuoterV2 — struct WITHOUT fee field
const ALGEBRA_QUOTER_ABI = [{
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

// Also try flat args variant
const ALGEBRA_FLAT_ABI = [{
  inputs: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" }
  ],
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

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const block = await provider.getBlockNumber()

  console.log(`\n═══ Real Camelot Quoter Test ═══`)
  console.log(`Block: ${block}`)
  console.log(`Quoter: ${REAL_CAMELOT_QUOTER}`)

  // Verify contract exists
  const code = await provider.getCode(REAL_CAMELOT_QUOTER)
  console.log(`Contract: ${code.length > 2 ? "✅ exists" : "❌ empty"} (${code.length} bytes)\n`)

  for (const pair of PAIRS) {
    console.log(`── ${pair.name} (${ethers.formatUnits(pair.amt, pair.tIn.dec)} ${pair.tIn.sym}) ──`)

    // Try struct ABI
    try {
      const quoter = new ethers.Contract(REAL_CAMELOT_QUOTER, ALGEBRA_QUOTER_ABI, provider)
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: pair.tIn.addr,
        tokenOut: pair.tOut.addr,
        amountIn: pair.amt,
        sqrtPriceLimitX96: 0n
      })
      const out = Number(ethers.formatUnits(result[0], pair.tOut.dec)).toFixed(4)
      const fee = Number(result[1])
      console.log(`  ✅ STRUCT ABI: ${out} ${pair.tOut.sym} (dynamic fee: ${(fee/10000*100).toFixed(2)}%)`)
    } catch (e) {
      console.log(`  ❌ Struct ABI: ${e.message.slice(0, 60)}`)
    }

    // Try flat ABI
    try {
      const quoter = new ethers.Contract(REAL_CAMELOT_QUOTER, ALGEBRA_FLAT_ABI, provider)
      const result = await quoter.quoteExactInputSingle.staticCall(
        pair.tIn.addr, pair.tOut.addr, pair.amt, 0n
      )
      const out = Number(ethers.formatUnits(result[0], pair.tOut.dec)).toFixed(4)
      const fee = Number(result[1])
      console.log(`  ✅ FLAT ABI:   ${out} ${pair.tOut.sym} (dynamic fee: ${(fee/10000*100).toFixed(2)}%)`)
    } catch (e) {
      console.log(`  ❌ Flat ABI:   ${e.message.slice(0, 60)}`)
    }

    await new Promise(r => setTimeout(r, 300))
    console.log()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
