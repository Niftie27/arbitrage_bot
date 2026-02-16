/**
 * fix-camelot-quoter.js
 * 
 * Diagnoses why Camelot quoter returns 0x on Arbitrum.
 * Tests multiple quoter addresses, ABI variants, and pool existence.
 * 
 * Run: node fix-camelot-quoter.js
 */

require("dotenv").config()
const ethers = require("ethers")

const RPC = process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc"

// Known/suspected Camelot quoter addresses on Arbitrum
const QUOTER_CANDIDATES = [
  { addr: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", label: "Camelot QuoterV2 (commonly cited)" },
  { addr: "0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1", label: "Algebra Integral QuoterV2 (newer)" },
  { addr: "0xAeC466F5ff5c3f93D3C2E9A0Ca3dB47f0F55BE26", label: "Camelot QuoterV1 (old)" },
]

// Camelot Algebra Factory
const CAMELOT_FACTORY = "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B"

// Test tokens
const WETH  = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8"
const LINK  = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4"
const ARB   = "0x912CE59144191C1204E64559FE8253a0e49E6548"
const USDC  = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"

const TEST_PAIRS = [
  { name: "WETH/PENDLE", tokenA: WETH, tokenB: PENDLE, amount: ethers.parseUnits("0.1", 18) },
  { name: "WETH/LINK", tokenA: WETH, tokenB: LINK, amount: ethers.parseUnits("0.1", 18) },
  { name: "WETH/ARB", tokenA: WETH, tokenB: ARB, amount: ethers.parseUnits("0.1", 18) },
  { name: "USDC/ARB", tokenA: USDC, tokenB: ARB, amount: ethers.parseUnits("100", 6) },
]

// ABI variants
const ABI_V3_STRUCT = [{
  inputs: [{ components: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "fee", type: "uint24" },
    { name: "sqrtPriceLimitX96", type: "uint160" }
  ], name: "params", type: "tuple" }],
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

const ABI_ALGEBRA_STRUCT = [{
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

const ABI_ALGEBRA_FLAT = [{
  inputs: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" }
  ],
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

const ABI_ALGEBRA_FLAT_WITH_FEE = [{
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

// Algebra factory ABI
const ALGEBRA_FACTORY_ABI = [
  { inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    name: "poolByPair", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
]

// Algebra pool ABI (for diagnostics)
const ALGEBRA_POOL_ABI = [
  { inputs: [], name: "globalState", outputs: [
    { name: "price", type: "uint160" }, { name: "tick", type: "int24" },
    { name: "feeZto", type: "uint16" }, { name: "feeOtz", type: "uint16" },
    { name: "timepointIndex", type: "uint16" }, { name: "communityFee", type: "uint8" },
    { name: "unlocked", type: "bool" }
  ], stateMutability: "view", type: "function" },
  { inputs: [], name: "liquidity", outputs: [{ type: "uint128" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "token0", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "token1", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
]

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const block = await provider.getBlockNumber()
  console.log(`\n═══ Camelot Quoter Diagnostic ═══`)
  console.log(`Block: ${block}\n`)

  // Step 1: Check if Camelot pools actually exist
  console.log(`── Step 1: Check Camelot Pool Existence ──\n`)
  const factory = new ethers.Contract(CAMELOT_FACTORY, ALGEBRA_FACTORY_ABI, provider)
  
  for (const pair of TEST_PAIRS) {
    try {
      const poolAddr = await factory.poolByPair(pair.tokenA, pair.tokenB)
      if (poolAddr === ethers.ZeroAddress) {
        console.log(`  ❌ ${pair.name}: NO POOL on Camelot`)
        continue
      }
      console.log(`  ✅ ${pair.name}: pool at ${poolAddr}`)
      
      // Check pool state
      const pool = new ethers.Contract(poolAddr, ALGEBRA_POOL_ABI, provider)
      try {
        const state = await pool.globalState()
        const liq = await pool.liquidity()
        console.log(`     sqrtPrice: ${state[0]}, tick: ${state[1]}, feeZto: ${state[2]}, feeOtz: ${state[3]}`)
        console.log(`     liquidity: ${liq}`)
        if (liq === 0n) {
          console.log(`     ⚠️ ZERO liquidity — pool exists but is empty`)
        }
      } catch (e) {
        // Try older globalState format
        try {
          const oldPoolABI = [{ inputs: [], name: "globalState", outputs: [
            { name: "price", type: "uint160" }, { name: "tick", type: "int24" },
            { name: "fee", type: "uint16" }, { name: "timepointIndex", type: "uint16" },
            { name: "communityFeeToken0", type: "uint8" }, { name: "communityFeeToken1", type: "uint8" },
            { name: "unlocked", type: "bool" }
          ], stateMutability: "view", type: "function" }]
          const pool2 = new ethers.Contract(poolAddr, oldPoolABI, provider)
          const state = await pool2.globalState()
          const liq = await pool.liquidity()
          console.log(`     sqrtPrice: ${state[0]}, tick: ${state[1]}, fee: ${state[2]}`)
          console.log(`     liquidity: ${liq}`)
          console.log(`     ℹ️ Uses OLD Algebra globalState format (single fee)`)
        } catch (e2) {
          console.log(`     ⚠️ Could not read pool state: ${e2.message.slice(0, 60)}`)
        }
      }
    } catch (e) {
      console.log(`  ❌ ${pair.name}: factory error — ${e.message.slice(0, 60)}`)
    }
    await sleep(300)
  }

  // Step 2: Check each quoter address
  console.log(`\n── Step 2: Test Quoter Addresses ──\n`)

  for (const q of QUOTER_CANDIDATES) {
    console.log(`  Testing: ${q.label}`)
    console.log(`  Address: ${q.addr}`)
    
    // Check if contract exists
    const code = await provider.getCode(q.addr)
    if (code === "0x") {
      console.log(`  ❌ No contract at this address\n`)
      continue
    }
    console.log(`  ✅ Contract exists (${code.length} bytes)`)

    // Try each ABI variant with WETH/ARB (most likely to have a pool)
    const abis = [
      { name: "V3 struct (with fee)", abi: ABI_V3_STRUCT, callFn: async (quoter) => {
        return quoter.quoteExactInputSingle.staticCall({
          tokenIn: WETH, tokenOut: ARB, amountIn: ethers.parseUnits("0.01", 18),
          fee: 3000, sqrtPriceLimitX96: 0n
        })
      }},
      { name: "Algebra struct (no fee)", abi: ABI_ALGEBRA_STRUCT, callFn: async (quoter) => {
        return quoter.quoteExactInputSingle.staticCall({
          tokenIn: WETH, tokenOut: ARB, amountIn: ethers.parseUnits("0.01", 18),
          sqrtPriceLimitX96: 0n
        })
      }},
      { name: "Algebra flat (4 outputs)", abi: ABI_ALGEBRA_FLAT, callFn: async (quoter) => {
        return quoter.quoteExactInputSingle.staticCall(
          WETH, ARB, ethers.parseUnits("0.01", 18), 0n
        )
      }},
      { name: "Algebra flat (5 outputs, fee)", abi: ABI_ALGEBRA_FLAT_WITH_FEE, callFn: async (quoter) => {
        return quoter.quoteExactInputSingle.staticCall(
          WETH, ARB, ethers.parseUnits("0.01", 18), 0n
        )
      }},
    ]

    for (const variant of abis) {
      try {
        const quoter = new ethers.Contract(q.addr, variant.abi, provider)
        const result = await variant.callFn(quoter)
        console.log(`  ✅ ${variant.name}: amountOut = ${result[0]}`)
        console.log(`     ^^^ THIS WORKS! Use this address + ABI variant.`)
      } catch (e) {
        const msg = e.message.slice(0, 70)
        console.log(`  ❌ ${variant.name}: ${msg}`)
      }
      await sleep(200)
    }
    console.log()
  }

  // Step 3: Try raw low-level call to find function selector
  console.log(`── Step 3: Function selector check ──\n`)
  const mainQuoter = QUOTER_CANDIDATES[0].addr
  
  // quoteExactInputSingle with struct (Algebra): 0xc6a5026a
  // quoteExactInputSingle with struct (V3): 0xc6a5026a  
  // quoteExactInputSingle flat args: 0xf7729d43
  const selectors = [
    { sig: "0xc6a5026a", name: "quoteExactInputSingle(tuple)" },
    { sig: "0xf7729d43", name: "quoteExactInputSingle(address,address,uint256,uint160)" },
    { sig: "0xcdca1753", name: "quoteExactInputSingle(address,address,uint256,uint24,uint160)" },
  ]
  
  for (const sel of selectors) {
    try {
      const result = await provider.call({ to: mainQuoter, data: sel.sig })
      console.log(`  ${sel.name}: returned ${result.slice(0, 20)}...`)
    } catch (e) {
      console.log(`  ${sel.name}: reverted — ${e.message.slice(0, 50)}`)
    }
    await sleep(200)
  }

  console.log(`\n═══ Diagnostic Complete ═══`)
  console.log(`\nCopy the working address + ABI variant back to arb-spread-logger.js`)
}

main().catch(e => { console.error(e); process.exit(1) })
