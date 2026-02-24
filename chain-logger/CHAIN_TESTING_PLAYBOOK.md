# Chain Testing Playbook
## Systematic Arbitrage Discovery Framework

**Version:** 2026-02-16  
**Rule:** No more research PDFs. Only executable data decides.

---

## THE SYSTEM

### Phase 1: Chain Triage (30 min per chain)

For each candidate chain, answer these 5 questions using DefiLlama + CoinGecko only:

| # | Question | Minimum threshold | Source |
|---|----------|------------------|--------|
| 1 | Total DEX volume (24h) | ≥ $5M/day | DefiLlama |
| 2 | Number of DEXes with >$1M daily volume | ≥ 2 | DefiLlama |
| 3 | Do ≥2 DEXes share overlapping pairs? | Yes | Manual check |
| 4 | Are there structurally different AMM types? | Preferred | DEX docs |
| 5 | Can you get WebSocket RPC? | Yes | ChainList/Alchemy |

**If any of 1, 2, 3, or 5 = NO → skip the chain. No exceptions.**

Question 4 is a bonus. "Structurally different" means: V2 vs V3, V3 vs Liquidity Book, V3 vs Algebra, V3 vs DODO PMM. Two Uniswap V3 forks = same model = probably efficiently arbed (as proven on Arbitrum).

---

### Phase 2: DEX Mapping (1 hour per chain)

For each chain that passes triage:

1. List top 3-5 DEXes by volume
2. Identify their AMM type (V2, V3, Algebra, LB, PMM, other)
3. Identify quoter contract addresses
4. Identify factory contract addresses
5. List the 10-15 most traded non-stablecoin pairs
6. Cross-reference: which pairs exist on ≥2 DEXes?

**Output: a config file. Not a document. Not a PDF.**

```
chains/avalanche.json
chains/scroll.json
chains/linea.json
```

---

### Phase 3: Executable Test (24 hours per chain)

Deploy the spread logger with:
- All overlapping pairs (up to 15)
- All DEX combinations
- 3 notional sizes: $100, $300, $1000
- 60-second polling (good enough for triage)
- Both directions per pair

**What you record:**
- Net spread after round-trip (buy A sell B, buy B sell A)
- Gas cost estimate
- Whether spread is positive
- Block numbers (for persistence)

---

### Phase 4: Kill or Promote (after 24h)

#### KILL the chain if:
- Zero positive spreads in 24h across all pairs/sizes → DEAD
- All positive spreads < gas cost → DEAD  
- Best spread < 0.3% → DEAD

#### PROMOTE the chain if:
- Any pair shows ≥ 0.5% net positive spread recurring ≥ 3 times in 24h
- Or: any pair shows ≥ 1.0% net positive spread even once
- Or: positive spreads appear on ≥ 3 different pairs (breadth signal)

#### EXTEND to 7 days if:
- Positive spreads exist but are borderline (0.3-0.5% range)
- Only 1-2 pairs show signal (might be noise)

---

### Phase 5: Deep Dive (only for promoted chains)

Only after a chain shows executable positive spreads:

1. Switch from 60s polling → event-driven (Swap listeners)
2. Add persistence tracking (does it last 2+ blocks?)
3. Add more pairs from the mid-tail
4. Reduce notional to find optimal size
5. Test for 7 days continuous
6. Model expected daily/monthly PnL

**Never do Phase 5 without passing Phase 4.**

---

## CHAIN PRIORITY ORDER

Based on structural reasoning (not hype):

### Tier 1 — Test first (different AMM models = highest hypothesis value)

| # | Chain | Why | Key DEXes | AMM diversity |
|---|-------|-----|-----------|---------------|
| 1 | **Avalanche** | Trader Joe LB (bins) vs Pangolin V3 vs Uni V3 | TJ, Pangolin, Uni | LB + V3 + V3 |
| 2 | **Fantom/Sonic** | SpookySwap vs Equalizer vs others, low MEV | Spooky, Equalizer, SpiritSwap | V2 + Solidly + V3 |

**Why these first:** Different AMM math creates structural friction in price convergence. This is the ONE variable that might produce drift, because the pools literally calculate prices differently.

### Tier 2 — Test second (newer L2s, lower competition)

| # | Chain | Why | Key DEXes | AMM diversity |
|---|-------|-----|-----------|---------------|
| 3 | **Scroll** | New L2, SyncSwap has custom AMM | SyncSwap, Ambient, Uni V3 | Custom + V3 |
| 4 | **Linea** | New L2, multiple DEXes | SyncSwap, Nile, Uni V3 | Mixed |
| 5 | **zkSync Era** | Established but not saturated | SyncSwap, Mute, SpaceFi | Mixed |

### Tier 3 — Test if Tier 1-2 fail

| # | Chain | Why | Key DEXes |
|---|-------|-----|-----------|
| 6 | **Polygon** | High volume, QuickSwap + Uni + Sushi | Multiple V3 |
| 7 | **Gnosis** | Low activity but very low MEV | Swapr, Honeyswap |
| 8 | **Celo** | Tiny but ignored | Ubeswap, Curve |
| 9 | **Moonbeam** | Polkadot EVM, very low competition | StellaSwap, Beamswap |

### Parallel Track — New chain monitoring

Not instead of testing. IN ADDITION:
- Monitor Berachain (just launched) — is memecoin activity starting?
- Monitor MegaETH — is DEX volume increasing from $40/day?
- Watch for new chain announcements

**Rule: never test a chain with < $1M daily DEX volume. Wait until it passes triage.**

---

## TIMELINE

```
Week 1 (Feb 17-23):
  Mon-Tue: Make logger chain-agnostic (config files)
  Wed:     Avalanche triage + DEX mapping + config
  Thu:     Avalanche 24h executable test (start)
  Fri:     Avalanche results → kill or promote
  Sat:     Fantom/Sonic triage + DEX mapping + config  
  Sun:     Fantom/Sonic 24h test (start)

Week 2 (Feb 24-Mar 2):
  Mon:     Fantom results → kill or promote
  Tue:     Scroll triage + DEX mapping
  Wed:     Scroll 24h test
  Thu:     Scroll results; Linea triage + mapping
  Fri:     Linea 24h test
  Sat-Sun: Linea results; zkSync if time

Week 3 (Mar 3-9):
  If ANY chain promoted: deep dive (event-driven, 7-day test)
  If NO chain promoted: Tier 3 chains OR reassess strategy class

Week 4 (Mar 10-16):
  Final Go/No-Go decision on cross-DEX arbitrage
  If Go: build execution pipeline for best chain
  If No-Go: pivot to different strategy (liquidations, new pool sniping, etc.)
```

---

## WHAT NEEDS TO BE BUILT

### 1. Chain-agnostic config loader (Day 1)
Move all addresses out of the logger into JSON configs.
Logger accepts `--chain avalanche` and loads the right file.

### 2. Quoter abstraction (Day 2)  
The logger already supports 3 ABI types:
- `v3` — standard Uniswap V3 QuoterV2 (struct with fee)
- `algebra` — Camelot/Algebra (flat args, no fee)
- **NEW: `lb`** — Trader Joe Liquidity Book quoter
- **NEW: `v2`** — Uniswap V2 style (getAmountsOut)

Each new chain may need 1-2 new quoter types. Add them as you encounter them.

### 3. Auto pair discovery (nice to have, Week 2)
Instead of manually listing pairs:
- Query factory contracts for pools with TVL > threshold
- Cross-reference across DEXes
- Auto-generate candidate list

---

## HARD RULES

1. **2 weeks max per chain.** If no signal in 24h test, kill it. If borderline, extend to 7 days max. Then move on.

2. **No research PDFs.** The only input to decisions is executable spread data from the logger.

3. **No mid-price analysis.** Everything is quoter-based round-trip. You proved mid-price spreads are illusions.

4. **Minimum 2 different AMM types per chain.** Two identical V3 forks will be efficiently arbed (proven on Arbitrum). You need structural friction.

5. **Kill fast, promote slow.** It's cheaper to test and fail than to research and wonder.

6. **One chain at a time in the logger.** Don't run 5 chains simultaneously. Sequential focus, parallel preparation.

7. **Log everything.** Every test run produces data. Even "all negative" is a data point that eliminates a chain permanently.

---

## SUCCESS DEFINITION

**Minimum viable success:** Find 1 chain + 1 pair + 1 DEX combination where:
- Net positive spreads appear ≥ 5 times per day
- At least 20% persist for ≥ 2 blocks  
- Net profit after gas is positive at ≥ $300 size
- This holds for ≥ 7 consecutive days

**If found:** Build execution pipeline. You have a real edge.
**If not found after 4 weeks (8+ chains tested):** Cross-DEX polling arbitrage is conclusively not viable at retail. Pivot strategy class entirely.

---

## THE HONEST FRAME

You are not "behind." You are not "missing something obvious."  
You are running a systematic elimination process.  
Most chains WILL fail. That's expected.  
You only need ONE to work.

The process is: test fast → fail fast → move on → repeat.  
Not: research deeply → hope → test once → disappointed.
