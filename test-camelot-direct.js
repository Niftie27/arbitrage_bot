/**
 * test-camelot-direct.js
 * 
 * Bypass the broken Camelot quoter entirely.
 * Call the Algebra pool's swap() function directly with staticCall.
 * This gives REAL executable output with no routing issues.
 * 
 * How it works:
 *   1. Get pool address from Camelot factory (poolByPair)
 *   2. Read pool state to determine token ordering
 *   3. Call pool.swap() with staticCall — simulates without executing
 *   4. Parse return values for exact output
 * 
 * Run: node test-camelot-direct.js
 */

require("dotenv").config()
const ethers = require("ethers")

const RPC = process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc"

// Camelot Algebra Factory
const CAMELOT_FACTORY = "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B"

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
  { name: "WETH→PENDLE", tokenIn: TOKENS.WETH, tokenOut: TOKENS.PENDLE, amount: ethers.parseUnits("0.5", 18) },
  { name: "PENDLE→WETH", tokenIn: TOKENS.PENDLE, tokenOut: TOKENS.WETH, amount: ethers.parseUnits("500", 18) },
  { name: "WETH→GNS",    tokenIn: TOKENS.WETH, tokenOut: TOKENS.GNS,    amount: ethers.parseUnits("0.5", 18) },
  { name: "WETH→MAGIC",  tokenIn: TOKENS.WETH, tokenOut: TOKENS.MAGIC,  amount: ethers.parseUnits("0.5", 18) },
  { name: "WETH→LINK",   tokenIn: TOKENS.WETH, tokenOut: TOKENS.LINK,   amount: ethers.parseUnits("0.5", 18) },
  { name: "WETH→ARB",    tokenIn: TOKENS.WETH, tokenOut: TOKENS.ARB,    amount: ethers.parseUnits("0.5", 18) },
  { name: "USDC→ARB",    tokenIn: TOKENS.USDC, tokenOut: TOKENS.ARB,    amount: ethers.parseUnits("500", 6) },
]

// ABIs
const FACTORY_ABI = [
  { inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    name: "poolByPair", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
]

const POOL_ABI = [
  { inputs: [], name: "token0", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "token1", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "liquidity", outputs: [{ type: "uint128" }], stateMutability: "view", type: "function" },
  // Algebra V1 globalState
  {
    inputs: [], name: "globalState",
    outputs: [
      { name: "price", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "feeZto", type: "uint16" },
      { name: "feeOtz", type: "uint16" },
      { name: "timepointIndex", type: "uint16" },
      { name: "communityFee", type: "uint8" },
      { name: "unlocked", type: "bool" }
    ],
    stateMutability: "view", type: "function"
  },
  // Algebra swap function — this is what we call with staticCall
  {
    inputs: [
      { name: "recipient", type: "address" },
      { name: "zeroToOne", type: "bool" },
      { name: "amountRequired", type: "int256" },
      { name: "limitSqrtPrice", type: "uint160" },
      { name: "data", type: "bytes" }
    ],
    name: "swap",
    outputs: [
      { name: "amount0", type: "int256" },
      { name: "amount1", type: "int256" }
    ],
    stateMutability: "nonpayable",
    type: "function"
  }
]

// Min/max sqrtPrice limits for swap direction
const MIN_SQRT_RATIO = 4295128739n + 1n          // min + 1
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n - 1n  // max - 1

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const factory = new ethers.Contract(CAMELOT_FACTORY, FACTORY_ABI, provider)
  const block = await provider.getBlockNumber()

  console.log(`\n═══ Camelot Direct Pool Swap Simulation ═══`)
  console.log(`Block: ${block}`)
  console.log(`Factory: ${CAMELOT_FACTORY}`)
  console.log(`Method: pool.swap() via staticCall (no quoter needed)\n`)

  // Cache pool info
  const poolCache = {}

  for (const pair of PAIRS) {
    console.log(`── ${pair.name} ──`)
    console.log(`  Input: ${ethers.formatUnits(pair.amount, pair.tokenIn.dec)} ${pair.tokenIn.sym}`)

    try {
      // Get pool
      const cacheKey = [pair.tokenIn.addr, pair.tokenOut.addr].sort().join("-")
      let poolAddr, pool, token0, token1

      if (poolCache[cacheKey]) {
        ({ poolAddr, pool, token0, token1 } = poolCache[cacheKey])
      } else {
        poolAddr = await factory.poolByPair(pair.tokenIn.addr, pair.tokenOut.addr)
        if (poolAddr === ethers.ZeroAddress) {
          console.log(`  ❌ No Camelot pool exists for this pair`)
          console.log()
          continue
        }
        pool = new ethers.Contract(poolAddr, POOL_ABI, provider)
        token0 = await pool.token0()
        token1 = await pool.token1()
        poolCache[cacheKey] = { poolAddr, pool, token0, token1 }
      }

      console.log(`  Pool: ${poolAddr}`)
      console.log(`  token0: ${token0}`)
      console.log(`  token1: ${token1}`)

      // Read pool state
      let state
      try {
        state = await pool.globalState()
        console.log(`  sqrtPrice: ${state[0]}, tick: ${state[1]}, feeZto: ${state[2]}, feeOtz: ${state[3]}`)
      } catch {
        // Try older format
        const oldABI = [{ inputs: [], name: "globalState", outputs: [
          { name: "price", type: "uint160" }, { name: "tick", type: "int24" },
          { name: "fee", type: "uint16" }, { name: "timepointIndex", type: "uint16" },
          { name: "communityFeeToken0", type: "uint8" }, { name: "communityFeeToken1", type: "uint8" },
          { name: "unlocked", type: "bool" }
        ], stateMutability: "view", type: "function" }]
        const pool2 = new ethers.Contract(poolAddr, oldABI, provider)
        state = await pool2.globalState()
        console.log(`  sqrtPrice: ${state[0]}, tick: ${state[1]}, fee: ${state[2]} (old format)`)
      }

      const liq = await pool.liquidity()
      console.log(`  liquidity: ${liq}`)

      if (liq === 0n) {
        console.log(`  ⚠️ ZERO liquidity — pool is empty`)
        console.log()
        continue
      }

      // Determine swap direction
      const zeroToOne = pair.tokenIn.addr.toLowerCase() === token0.toLowerCase()
      const sqrtPriceLimit = zeroToOne ? MIN_SQRT_RATIO : MAX_SQRT_RATIO

      console.log(`  direction: ${zeroToOne ? "token0→token1" : "token1→token0"}`)
      console.log(`  sqrtPriceLimit: ${sqrtPriceLimit}`)

      // Call swap with staticCall
      // amountRequired > 0 means exact input
      try {
        const result = await pool.swap.staticCall(
          "0x0000000000000000000000000000000000000001",  // dummy recipient
          zeroToOne,
          pair.amount,  // positive = exact input
          sqrtPriceLimit,
          "0x"  // empty callback data
        )

        const amount0 = result[0]
        const amount1 = result[1]

        console.log(`  amount0: ${amount0}`)
        console.log(`  amount1: ${amount1}`)

        // Determine output
        // For exact input: input is positive, output is negative
        const outToken = zeroToOne ? pair.tokenOut : pair.tokenIn
        const outAmount = zeroToOne ? -amount1 : -amount0
        const outFormatted = ethers.formatUnits(outAmount, outToken.dec)

        // Sanity check: calculate implied price
        const inUSD = pair.tokenIn.sym === "USDC" ? Number(ethers.formatUnits(pair.amount, pair.tokenIn.dec)) :
                      Number(ethers.formatUnits(pair.amount, pair.tokenIn.dec)) * (pair.tokenIn.sym === "WETH" ? 2070 : 1)
        
        console.log(`\n  ✅ OUTPUT: ${Number(outFormatted).toFixed(6)} ${pair.tokenOut.sym}`)
        console.log(`     Input value: ~$${inUSD.toFixed(0)}`)

      } catch (e) {
        // staticCall swap will revert if there's a callback requirement
        // Parse the revert to extract amounts
        const errMsg = e.message
        
        if (errMsg.includes("IAlgebraSwapCallback")) {
          console.log(`\n  ⚠️ Swap reverted with callback requirement`)
          console.log(`  This is expected — Algebra pools need a callback contract.`)
          console.log(`  Need to deploy a quoter helper or use a different approach.`)
        } else if (errMsg.includes("SPL")) {
          console.log(`\n  ❌ Swap reverted: price limit reached (not enough liquidity)`)
        } else if (errMsg.includes("IIA")) {
          console.log(`\n  ❌ Swap reverted: insufficient input amount`)
        } else {
          console.log(`\n  ❌ Swap reverted: ${errMsg.slice(0, 100)}`)
        }
      }

    } catch (e) {
      console.log(`  ❌ Error: ${e.message.slice(0, 80)}`)
    }

    console.log()
    await sleep(500)
  }

  console.log(`═══ Done ═══`)
  console.log(`\nIf swaps work: we can integrate direct pool calls into the logger.`)
  console.log(`If callback required: we need to find/deploy an Algebra-specific quoter.`)
}

main().catch(e => { console.error(e); process.exit(1) })
