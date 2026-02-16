/**
 * probe-camelot-raw.js
 * 
 * The flat ABI returned data (not revert) — meaning the function works
 * but output format is wrong. This script:
 * 1. Makes raw eth_call with known-good function selector
 * 2. Captures raw hex output
 * 3. Tries multiple decode formats to find the right one
 */

require("dotenv").config()
const ethers = require("ethers")

const RPC = process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc"
const QUOTER = "0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E"

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
const ARB  = "0x912CE59144191C1204E64559FE8253a0e49E6548"
const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8"
const LINK = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4"

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const block = await provider.getBlockNumber()
  console.log(`\n═══ Camelot Quoter Raw Probe ═══`)
  console.log(`Block: ${block}\n`)

  // First: let's check what functions exist on the contract
  // Try getting function selectors by calling with minimal data
  
  const testPairs = [
    { name: "WETH→ARB", tIn: WETH, tOut: ARB, amt: ethers.parseUnits("0.01", 18) },
    { name: "WETH→PENDLE", tIn: WETH, tOut: PENDLE, amt: ethers.parseUnits("0.5", 18) },
    { name: "WETH→LINK", tIn: WETH, tOut: LINK, amt: ethers.parseUnits("0.5", 18) },
  ]

  // Different function signatures to try
  const signatures = [
    {
      name: "quoteExactInputSingle(address,address,uint256,uint160)",
      selector: ethers.id("quoteExactInputSingle(address,address,uint256,uint160)").slice(0, 10),
      encode: (tIn, tOut, amt) => ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint160"],
        [tIn, tOut, amt, 0n]
      )
    },
    {
      // With fee param (V3 style flat)
      name: "quoteExactInputSingle(address,address,uint24,uint256,uint160)",
      selector: ethers.id("quoteExactInputSingle(address,address,uint24,uint256,uint160)").slice(0, 10),
      encode: (tIn, tOut, amt) => ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "uint256", "uint160"],
        [tIn, tOut, 0, amt, 0n]
      )
    },
    {
      // Struct with 4 fields (Algebra style)
      name: "quoteExactInputSingle((address,address,uint256,uint160))",
      selector: ethers.id("quoteExactInputSingle((address,address,uint256,uint160))").slice(0, 10),
      encode: (tIn, tOut, amt) => ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,uint256,uint160)"],
        [[tIn, tOut, amt, 0n]]
      )
    },
    {
      // Struct with 5 fields (V3 style)
      name: "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
      selector: ethers.id("quoteExactInputSingle((address,address,uint256,uint24,uint160))").slice(0, 10),
      encode: (tIn, tOut, amt) => ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,uint256,uint24,uint160)"],
        [[tIn, tOut, amt, 0, 0n]]
      )
    },
    {
      // Maybe different order: tokenIn, tokenOut, amountIn, limitSqrtPrice
      name: "quoteExactInputSingle(address,address,uint256,uint160) [alt order]",
      selector: ethers.id("quoteExactInputSingle(address,address,uint256,uint160)").slice(0, 10),
      encode: (tIn, tOut, amt) => ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint160"],
        [tIn, tOut, amt, 0n]
      )
    },
  ]

  // Step 1: Test which function selector returns data
  const pair = testPairs[0]
  console.log(`Testing selectors with ${pair.name}...\n`)

  for (const sig of signatures) {
    try {
      const calldata = sig.selector + sig.encode(pair.tIn, pair.tOut, pair.amt).slice(2)
      const result = await provider.call({
        to: QUOTER,
        data: calldata
      })
      console.log(`  ${sig.name}`)
      console.log(`  Selector: ${sig.selector}`)
      console.log(`  Result length: ${result.length} chars (${(result.length - 2) / 64} words)`)
      console.log(`  Raw: ${result.slice(0, 130)}...`)
      
      // Try multiple decode formats
      const decoders = [
        { name: "(uint256)", types: ["uint256"] },
        { name: "(uint256,uint16)", types: ["uint256", "uint16"] },
        { name: "(uint256,uint160,uint32,uint256)", types: ["uint256", "uint160", "uint32", "uint256"] },
        { name: "(uint256,uint16,uint160,uint32,uint256)", types: ["uint256", "uint16", "uint160", "uint32", "uint256"] },
        { name: "(uint256,uint16,uint160,uint32)", types: ["uint256", "uint16", "uint160", "uint32"] },
      ]

      for (const dec of decoders) {
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(dec.types, result)
          const amountOut = decoded[0]
          const formatted = Number(ethers.formatUnits(amountOut, 18)).toFixed(4)
          console.log(`    ✅ Decoded as ${dec.name}: amountOut=${formatted} (raw: ${amountOut})`)
          if (dec.types.length > 1) {
            for (let i = 1; i < decoded.length; i++) {
              console.log(`       [${i}]: ${decoded[i]}`)
            }
          }
        } catch {
          // skip
        }
      }
      console.log()
    } catch (e) {
      console.log(`  ${sig.name}: ❌ ${e.message.slice(0, 50)}`)
    }
  }

  // Step 2: If we found a working selector+decoder, test all pairs
  console.log(`\n── Testing all pairs with flat Algebra ABI ──\n`)
  
  const workingSelector = ethers.id("quoteExactInputSingle(address,address,uint256,uint160)").slice(0, 10)
  
  for (const pair of testPairs) {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256", "uint160"],
      [pair.tIn, pair.tOut, pair.amt, 0n]
    )
    const calldata = workingSelector + encoded.slice(2)
    
    try {
      const result = await provider.call({ to: QUOTER, data: calldata })
      const words = (result.length - 2) / 64
      console.log(`  ${pair.name}: ${words} words returned`)
      
      // Try simplest decode
      if (words >= 1) {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], result)
        const dec = pair.tOut === ARB ? 18 : pair.tOut === PENDLE ? 18 : 18
        console.log(`    amountOut: ${Number(ethers.formatUnits(decoded[0], dec)).toFixed(4)}`)
      }
    } catch (e) {
      console.log(`  ${pair.name}: ❌ ${e.message.slice(0, 60)}`)
    }
    await new Promise(r => setTimeout(r, 300))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
