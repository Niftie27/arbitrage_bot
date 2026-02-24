# Chain-Agnostic Spread Logger

Systematic executable spread detection across any EVM chain.
Part of the **Chain Testing Playbook** (see CHAIN_TESTING_PLAYBOOK.md).

## Quick Start

```bash
# Install deps (once)
npm install ethers@6 dotenv

# Run on Avalanche (first chain in playbook)
node spread-logger.js --chain avalanche

# With custom notionals and polling
node spread-logger.js --chain avalanche --notional 100,300,1000 --interval 30

# Single pair focus
node spread-logger.js --chain avalanche --pair WAVAX/USDCe

# Run on Arbitrum (existing baseline — should show all-negative)
node spread-logger.js --chain arbitrum
```

## Custom RPC

Set env var `<CHAIN>_RPC` to override the default public RPC:
```bash
export AVALANCHE_RPC="https://avax-mainnet.g.alchemy.com/v2/YOUR_KEY"
export ARBITRUM_RPC="https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY"
```

## Adding a New Chain

1. Copy `chains/_template.json` → `chains/<chain>.json`
2. Fill in: RPC, token addresses, DEX quoter/factory/router addresses
3. Run: `node spread-logger.js --chain <chain>`

## Supported Quoter Types

| Type | AMM Model | Quote Method | Examples |
|------|-----------|-------------|----------|
| `v3` | Uniswap V3 (ticks) | `QuoterV2.quoteExactInputSingle()` | Uniswap, Pancakeswap, SushiSwap V3 |
| `v2` | Uniswap V2 (xy=k) | `Router.getAmountsOut()` | Pangolin, SushiSwap V1, SpookySwap |
| `algebra` | Algebra (dynamic fee) | `quoteExactInputSingle()` | Camelot, QuickSwap V3, Zyberswap |
| `lb` | Liquidity Book (bins) | `LBQuoter.findBestPathFromAmountIn()` | Trader Joe / LFJ |

## Output

Raw data → `spread_logs/<chain>/spreads_YYYYMMDD.jsonl`

Each line is a JSON record:
```json
{"ts":"...","block":123,"chain":"avalanche","pair":"WAVAX/USDCe","dir":"TraderJoeLB→Pangolin","notional":300,"spreadPct":"0.4521","netPct":"0.4188","netUSD":"1.26","inUSD":"300.00","outUSD":"301.36"}
```

## Kill/Promote Criteria

Press Ctrl+C to get the verdict:
- **KILL**: Zero positive spreads, or all below gas
- **EXTEND**: Some positive but borderline
- **PROMOTE**: Recurring ≥0.5% spreads persisting ≥2 blocks

## Chain Priority (from Playbook)

1. **Avalanche** — LB vs V3 vs V2 (3 different AMM models!)
2. **Fantom/Sonic** — Solidly vs V2 vs V3
3. **Scroll** — SyncSwap custom AMM vs V3
4. **Linea** — SyncSwap + Nile vs V3
5. **zkSync Era** — SyncSwap + Mute vs V3

## File Structure

```
spread-logger.js          # Main logger (chain-agnostic)
chains/
  avalanche.json           # Avalanche config (ready)
  arbitrum.json            # Arbitrum config (baseline)
  _template.json           # Template for new chains
spread_logs/
  avalanche/               # Auto-created on first run
    spreads_20260224.jsonl  # Raw data
CHAIN_TESTING_PLAYBOOK.md  # Strategy & rules
```
