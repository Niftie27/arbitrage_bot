/**
 * scan-chains-depth.js
 * 
 * Multi-chain depth-first DEX fragmentation scanner.
 * 
 * PURPOSE: Find pairs where 2+ DEXes BOTH have real liquidity ($30k+).
 * This is the lesson from Mantle: spread without depth = mirage.
 * 
 * CHAINS:
 *   Arbitrum  — control group (guaranteed fragmentation, used to validate scanner)
 *   Scroll    — original thesis candidate
 *   Linea     — secondary candidate
 * 
 * For each chain, scans V3 factory contracts for all token-pair combinations
 * across multiple DEXes. Reports pairs where ≥2 DEXes have $30k+ TVL.
 * 
 * Usage:
 *   node scan-chains-depth.js                    # all 3 chains
 *   node scan-chains-depth.js --chain scroll     # scroll only
 *   node scan-chains-depth.js --chain arbitrum    # arbitrum only
 *   node scan-chains-depth.js --min-tvl 50000    # $50k minimum per venue
 */

const ethers = require("ethers")

// ── CLI ──
const args = process.argv.slice(2)
const CHAIN_FILTER = args.find((a, i) => args[i - 1] === "--chain") || "all"
const MIN_TVL = parseInt(args.find((a, i) => args[i - 1] === "--min-tvl") || "30000")
const MIN_VENUES = 2

// ── CHAIN CONFIGS ──
const CHAINS = {
  arbitrum: {
    name: "Arbitrum One",
    rpc: "https://arb1.arbitrum.io/rpc",
    chainId: 42161,
    // Blue-chip tokens on Arbitrum
    tokens: {
      WETH:   { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, priceUSD: 2700 },
      USDC:   { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, priceUSD: 1 },
      USDCe:  { address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", decimals: 6, priceUSD: 1 },
      USDT:   { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, priceUSD: 1 },
      WBTC:   { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, priceUSD: 95000 },
      ARB:    { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, priceUSD: 0.8 },
      GMX:    { address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", decimals: 18, priceUSD: 25 },
      LINK:   { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, priceUSD: 18 },
      DAI:    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, priceUSD: 1 },
      wstETH: { address: "0x5979D7b546E38E414F7E9822514be443A4800529", decimals: 18, priceUSD: 3200 },
      PENDLE: { address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", decimals: 18, priceUSD: 4 },
      GNS:    { address: "0x18c11FD286C5EC11c3b683Caa813B77f5163A122", decimals: 18, priceUSD: 3 },
      RDNT:   { address: "0x3082CC23568eA640225c2467653dB90e9250AaA0", decimals: 18, priceUSD: 0.06 },
      GRAIL:  { address: "0x3d9907F9a2828e2735f8257539C11F4A76aBe7CE", decimals: 18, priceUSD: 1500 },
      MAGIC:  { address: "0x539bdE0d7Dbd336b79148AA742883198BBF60342", decimals: 18, priceUSD: 0.4 },
    },
    dexes: [
      { name: "Uniswap V3",    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", type: "v3", fees: [100, 500, 3000, 10000] },
      { name: "SushiSwap V3",  factory: "0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e", type: "v3", fees: [100, 500, 3000, 10000] },
      { name: "Camelot V3",    factory: "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B", type: "algebra" },
      { name: "Pancakeswap V3",factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", type: "v3", fees: [100, 500, 2500, 10000] },
      { name: "Ramses V3",    factory: "0xAA2cd7477c451E703f3B9Ba5663334914763edF8", type: "algebra" },
    ]
  },

  scroll: {
    name: "Scroll",
    rpc: "https://rpc.scroll.io",
    chainId: 534352,
    tokens: {
      WETH:   { address: "0x5300000000000000000000000000000000000004", decimals: 18, priceUSD: 2700 },
      USDC:   { address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", decimals: 6, priceUSD: 1 },
      USDT:   { address: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", decimals: 6, priceUSD: 1 },
      wstETH: { address: "0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32", decimals: 18, priceUSD: 3200 },
      SCR:    { address: "0xd29687c813D741E2F938F4aC377128810E217b1b", decimals: 18, priceUSD: 0.5 },
      WBTC:   { address: "0x3C1BCa5a656e69edCD0D4E36BEbb31CEDAf12dfd", decimals: 8, priceUSD: 95000 },
      DAI:    { address: "0xcA77eB3fEFe3725Dc33bccB54eDEFc3D9f764f97", decimals: 18, priceUSD: 1 },
      weETH:  { address: "0x01f0a31698C4d065659b9bdC21B3610292a1c506", decimals: 18, priceUSD: 2800 },
      STONE:  { address: "0x80137510979B232De2bfF40b3910e22dCeC0C8AC", decimals: 18, priceUSD: 2800 },
    },
    dexes: [
      { name: "Nuri/Uniswap", factory: "0xAAA32926fcE6bE95ea2c51cB4Fcb60836D320C42", type: "algebra" },
      { name: "SyncSwap (CL)", factory: "0x37BAc764494c8db4e54BDE72f6965beA9fa0AC2d", type: "v3", fees: [100, 500, 3000, 10000] },
      { name: "SushiSwap V3",  factory: "0x46B3fDF7b5CDe91Ac049936bF0bDb12c5d22202e", type: "v3", fees: [100, 500, 3000, 10000] },
      { name: "iZiSwap",       factory: "0x8c7d3063579BdB0b90997e18A770eaE32E1eBb08", type: "izi", fees: [400, 2000, 10000] },
    ]
  },

  linea: {
    name: "Linea",
    rpc: "https://rpc.linea.build",
    chainId: 59144,
    tokens: {
      WETH:   { address: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", decimals: 18, priceUSD: 2700 },
      USDC:   { address: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", decimals: 6, priceUSD: 1 },
      USDT:   { address: "0xA219439258ca9da29E9Cc4cE5596924745e12B93", decimals: 6, priceUSD: 1 },
      WBTC:   { address: "0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4", decimals: 8, priceUSD: 95000 },
      wstETH: { address: "0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F", decimals: 18, priceUSD: 3200 },
      DAI:    { address: "0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5", decimals: 18, priceUSD: 1 },
      weETH:  { address: "0x1Bf74C010E6320bab11e2e5A532b5AC15e0b8aA6", decimals: 18, priceUSD: 2800 },
      ezETH:  { address: "0x2416092f143378750bb29b79eD961ab195CcEea5", decimals: 18, priceUSD: 2700 },
    },
    dexes: [
      { name: "Lynex V3",     factory: "0x622b2c98123D303ae067DB4925CD6282B3A08D0F", type: "algebra" },
      { name: "iZiSwap",      factory: "0x45e5F26451CDB01B0fA1f8582E0aAD9A6F27C218", type: "izi", fees: [400, 2000, 10000] },
      { name: "SyncSwap (CL)", factory: "0x7aCCE5B1c68E23D43D5c89947A5b9649715710ce", type: "v3", fees: [100, 500, 3000, 10000] },
      { name: "Nile V3",      factory: "0xAAA32926fcE6bE95ea2c51cB4Fcb60836D320C42", type: "algebra" },
    ]
  }
}

// ── ABIs ──
const V3_FACTORY_ABI = [{
  inputs: [{type:"address"},{type:"address"},{type:"uint24"}],
  name: "getPool", outputs: [{type:"address"}],
  stateMutability: "view", type: "function"
}]

const ALGEBRA_FACTORY_ABI = [{
  inputs: [{type:"address"},{type:"address"}],
  name: "poolByPair", outputs: [{type:"address"}],
  stateMutability: "view", type: "function"
}]

const IZI_FACTORY_ABI = [{
  inputs: [{type:"address"},{type:"address"},{type:"uint24"}],
  name: "pool", outputs: [{type:"address"}],
  stateMutability: "view", type: "function"
}]

const IERC20 = ["function balanceOf(address) view returns (uint256)"]

// ── MAIN ──
async function main() {
  console.log("═══════════════════════════════════════════════════════════")
  console.log("  Multi-Chain Depth-First DEX Fragmentation Scanner")
  console.log("  Lesson from Mantle: depth first, spreads second.")
  console.log("═══════════════════════════════════════════════════════════")
  console.log(`  Min TVL per venue: $${MIN_TVL.toLocaleString()}`)
  console.log(`  Min venues: ${MIN_VENUES}`)
  console.log()

  const chainsToScan = CHAIN_FILTER === "all"
    ? Object.keys(CHAINS)
    : [CHAIN_FILTER.toLowerCase()]

  const allResults = []

  for (const chainKey of chainsToScan) {
    const chain = CHAINS[chainKey]
    if (!chain) {
      console.log(`  ⚠️ Unknown chain: ${chainKey}`)
      continue
    }

    console.log(`\n${"═".repeat(60)}`)
    console.log(`  SCANNING: ${chain.name} (chainId ${chain.chainId})`)
    console.log(`  RPC: ${chain.rpc}`)
    console.log(`  Tokens: ${Object.keys(chain.tokens).length}`)
    console.log(`  DEXes: ${chain.dexes.map(d => d.name).join(", ")}`)
    console.log(`${"═".repeat(60)}\n`)

    const provider = new ethers.JsonRpcProvider(chain.rpc)

    // Verify RPC works
    try {
      const block = await provider.getBlockNumber()
      console.log(`  ✅ Connected (block ${block})`)
    } catch (e) {
      console.log(`  ❌ RPC failed: ${e.message.slice(0, 60)}`)
      continue
    }

    // ── Factory self-test: verify each DEX factory responds ──
    console.log(`  Factory self-test (WETH-based pair lookup)...`)
    const wethAddr = chain.tokens.WETH?.address
    const stableAddr = chain.tokens.USDC?.address || chain.tokens.USDT?.address
    const activeDexes = []

    for (const dex of chain.dexes) {
      if (!wethAddr || !stableAddr) { activeDexes.push(dex); continue }
      try {
        let found = false
        if (dex.type === "v3") {
          const f = new ethers.Contract(dex.factory, V3_FACTORY_ABI, provider)
          for (const fee of dex.fees) {
            const p = await f.getPool(wethAddr, stableAddr, fee)
            if (p && p !== ethers.ZeroAddress) { found = true; break }
          }
        } else if (dex.type === "algebra") {
          const f = new ethers.Contract(dex.factory, ALGEBRA_FACTORY_ABI, provider)
          const p = await f.poolByPair(wethAddr, stableAddr)
          if (p && p !== ethers.ZeroAddress) { found = true }
        } else if (dex.type === "izi") {
          const f = new ethers.Contract(dex.factory, IZI_FACTORY_ABI, provider)
          for (const fee of (dex.fees || [400, 2000, 10000])) {
            const p = await f.pool(wethAddr, stableAddr, fee)
            if (p && p !== ethers.ZeroAddress) { found = true; break }
          }
        }
        console.log(`    ${found ? "✅" : "⚠️"} ${dex.name}: ${found ? "factory responds" : "no WETH/stable pool found (factory may be wrong)"}`)
        activeDexes.push(dex)
      } catch (e) {
        console.log(`    ❌ ${dex.name}: factory call FAILED — ${e.message.slice(0, 50)}`)
        console.log(`       → Skipping this DEX. Address may be wrong: ${dex.factory}`)
      }
      await sleep(200)
    }
    chain.dexes = activeDexes  // only use dexes that didn't hard-fail
    console.log()

    // Generate all token pairs
    const tokenNames = Object.keys(chain.tokens)
    const pairs = []
    for (let i = 0; i < tokenNames.length; i++) {
      for (let j = i + 1; j < tokenNames.length; j++) {
        pairs.push([tokenNames[i], tokenNames[j]])
      }
    }
    console.log(`  Token pairs to check: ${pairs.length}`)
    console.log()

    // For each pair, check each DEX for pool existence + TVL
    const pairResults = {}
    let checked = 0

    for (const [nameA, nameB] of pairs) {
      const tokenA = chain.tokens[nameA]
      const tokenB = chain.tokens[nameB]
      const pairKey = `${nameA}/${nameB}`
      pairResults[pairKey] = { venues: [], totalTVL: 0 }

      for (const dex of chain.dexes) {
        try {
          let poolAddress = null

          if (dex.type === "v3") {
            const factory = new ethers.Contract(dex.factory, V3_FACTORY_ABI, provider)
            // Check best fee tier
            for (const fee of dex.fees) {
              try {
                const addr = await factory.getPool(tokenA.address, tokenB.address, fee)
                if (addr && addr !== ethers.ZeroAddress) {
                  // Check TVL
                  const tvl = await getPoolTVL(provider, addr, tokenA, tokenB, nameA, nameB)
                  if (tvl > 0) {
                    // Keep the best fee tier
                    const existing = pairResults[pairKey].venues.find(v => v.dex === dex.name)
                    if (!existing || tvl > existing.tvl) {
                      if (existing) {
                        pairResults[pairKey].venues = pairResults[pairKey].venues.filter(v => v.dex !== dex.name)
                      }
                      pairResults[pairKey].venues.push({
                        dex: dex.name, pool: addr, fee, tvl, feePct: fee / 10000
                      })
                    }
                  }
                }
              } catch (_) {}
            }
          } else if (dex.type === "algebra") {
            const factory = new ethers.Contract(dex.factory, ALGEBRA_FACTORY_ABI, provider)
            try {
              const addr = await factory.poolByPair(tokenA.address, tokenB.address)
              if (addr && addr !== ethers.ZeroAddress) {
                const tvl = await getPoolTVL(provider, addr, tokenA, tokenB, nameA, nameB)
                if (tvl > 0) {
                  pairResults[pairKey].venues.push({
                    dex: dex.name, pool: addr, fee: "dynamic", tvl, feePct: "dyn"
                  })
                }
              }
            } catch (_) {}
          } else if (dex.type === "izi") {
            const factory = new ethers.Contract(dex.factory, IZI_FACTORY_ABI, provider)
            for (const fee of (dex.fees || [400, 2000, 10000])) {
              try {
                const addr = await factory.pool(tokenA.address, tokenB.address, fee)
                if (addr && addr !== ethers.ZeroAddress) {
                  const tvl = await getPoolTVL(provider, addr, tokenA, tokenB, nameA, nameB)
                  if (tvl > 0) {
                    const existing = pairResults[pairKey].venues.find(v => v.dex === dex.name)
                    if (!existing || tvl > existing.tvl) {
                      if (existing) {
                        pairResults[pairKey].venues = pairResults[pairKey].venues.filter(v => v.dex !== dex.name)
                      }
                      pairResults[pairKey].venues.push({
                        dex: dex.name, pool: addr, fee, tvl, feePct: fee / 10000
                      })
                    }
                  }
                }
              } catch (_) {}
            }
          }
        } catch (e) {
          // Skip silently
        }

        // Small delay to avoid rate limiting (public RPCs)
        await sleep(150)
      }

      pairResults[pairKey].totalTVL = pairResults[pairKey].venues.reduce((s, v) => s + v.tvl, 0)
      checked++

      if (checked % 10 === 0) {
        process.stdout.write(`  Checked ${checked}/${pairs.length} pairs...\r`)
      }
    }

    console.log(`  Checked ${checked}/${pairs.length} pairs.          `)

    // Filter: pairs with ≥MIN_VENUES venues above MIN_TVL
    const viable = []
    for (const [pair, data] of Object.entries(pairResults)) {
      const qualifiedVenues = data.venues.filter(v => v.tvl >= MIN_TVL)
      if (qualifiedVenues.length >= MIN_VENUES) {
        viable.push({ pair, venues: qualifiedVenues, totalTVL: data.totalTVL })
      }
    }

    // Sort by total TVL
    viable.sort((a, b) => b.totalTVL - a.totalTVL)

    console.log(`\n  ── ${chain.name}: VIABLE PAIRS (≥${MIN_VENUES} venues with $${(MIN_TVL/1000).toFixed(0)}k+) ──\n`)

    if (viable.length === 0) {
      console.log(`  ❌ No pairs found with ${MIN_VENUES}+ venues above $${(MIN_TVL/1000).toFixed(0)}k`)
      console.log(`  This chain may have one-DEX dominance (like Mantle).`)
    } else {
      for (const v of viable) {
        const feeInfo = v.venues.map(ven =>
          `${ven.dex} ($${(ven.tvl/1000).toFixed(0)}k, fee=${ven.feePct}%)`
        ).join(" | ")
        console.log(`  ✅ ${v.pair.padEnd(12)} — TVL $${(v.totalTVL/1000).toFixed(0)}k — ${v.venues.length} venues`)
        console.log(`     ${feeInfo}`)
      }
    }

    allResults.push({ chain: chain.name, chainKey, viable })
    console.log()
  }

  // ── CROSS-CHAIN SUMMARY ──
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  CROSS-CHAIN COMPARISON`)
  console.log(`${"═".repeat(60)}\n`)

  const pad = (s, n) => String(s).padEnd(n)

  for (const r of allResults) {
    const emoji = r.viable.length >= 5 ? "🟢" : r.viable.length >= 1 ? "🟡" : "🔴"
    console.log(`  ${emoji} ${pad(r.chain, 15)} — ${r.viable.length} viable pairs`)

    for (const v of r.viable.slice(0, 5)) {
      const feeBudget = v.venues.reduce((min, ven) => {
        const f = typeof ven.feePct === 'number' ? ven.feePct : 0.1
        return min + f
      }, 0)
      const minVenueTVL = Math.min(...v.venues.map(ven => ven.tvl))
      console.log(`     ${pad(v.pair, 12)} — min venue $${(minVenueTVL/1000).toFixed(0)}k — ~${feeBudget.toFixed(2)}% round-trip fees`)
    }
    if (r.viable.length > 5) console.log(`     ... +${r.viable.length - 5} more`)
    console.log()
  }

  // Verdict
  console.log(`  VERDICT:`)
  const best = allResults.sort((a, b) => b.viable.length - a.viable.length)[0]
  if (best && best.viable.length > 0) {
    console.log(`  → ${best.chain} has the most fragmentation (${best.viable.length} viable pairs)`)
    console.log(`  → Next step: run spread monitoring on top 3-5 pairs`)
  } else {
    console.log(`  → No viable pairs found on any chain. Lower MIN_TVL or expand token list.`)
  }
}

async function getPoolTVL(provider, poolAddress, tokenA, tokenB, nameA, nameB) {
  try {
    const balA = new ethers.Contract(tokenA.address, IERC20, provider)
    const balB = new ethers.Contract(tokenB.address, IERC20, provider)

    const [rawA, rawB] = await Promise.all([
      balA.balanceOf(poolAddress),
      balB.balanceOf(poolAddress)
    ])

    const amtA = Number(ethers.formatUnits(rawA, tokenA.decimals))
    const amtB = Number(ethers.formatUnits(rawB, tokenB.decimals))

    return amtA * tokenA.priceUSD + amtB * tokenB.priceUSD
  } catch (e) {
    return 0
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

main().catch(e => { console.error(e); process.exit(1) })
