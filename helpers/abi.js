// ── Pool ABIs for Mantle: Merchant Moe LB + Agni V3 ──

// Agni Finance = standard Uniswap V3 fork
// Uses the STANDARD V3 Swap event (no extra protocolFees fields like Pancake)
const IAgniV3Pool = [
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true,  "internalType": "address", "name": "sender",    "type": "address" },
      { "indexed": true,  "internalType": "address", "name": "recipient", "type": "address" },
      { "indexed": false, "internalType": "int256",  "name": "amount0",   "type": "int256" },
      { "indexed": false, "internalType": "int256",  "name": "amount1",   "type": "int256" },
      { "indexed": false, "internalType": "uint160", "name": "sqrtPriceX96", "type": "uint160" },
      { "indexed": false, "internalType": "uint128", "name": "liquidity", "type": "uint128" },
      { "indexed": false, "internalType": "int24",   "name": "tick",      "type": "int24" }
    ],
    "name": "Swap",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "slot0",
    "outputs": [
      { "internalType": "uint160", "name": "sqrtPriceX96", "type": "uint160" },
      { "internalType": "int24",   "name": "tick", "type": "int24" },
      { "internalType": "uint16",  "name": "observationIndex", "type": "uint16" },
      { "internalType": "uint16",  "name": "observationCardinality", "type": "uint16" },
      { "internalType": "uint16",  "name": "observationCardinalityNext", "type": "uint16" },
      { "internalType": "uint8",   "name": "feeProtocol", "type": "uint8" },
      { "internalType": "bool",    "name": "unlocked", "type": "bool" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "token0",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "token1",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  }
]

// Merchant Moe LBPair — Joe V2.1 fork
// Swap event for event-driven monitoring
const ILBPairSwap = [
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true,  "internalType": "address", "name": "sender", "type": "address" },
      { "indexed": true,  "internalType": "address", "name": "to",     "type": "address" },
      { "indexed": false, "internalType": "uint24",  "name": "id",     "type": "uint24" },
      { "indexed": false, "internalType": "bytes32", "name": "amountsIn",  "type": "bytes32" },
      { "indexed": false, "internalType": "bytes32", "name": "amountsOut", "type": "bytes32" },
      { "indexed": false, "internalType": "uint24",  "name": "volatilityAccumulator", "type": "uint24" },
      { "indexed": false, "internalType": "bytes32", "name": "totalFees",    "type": "bytes32" },
      { "indexed": false, "internalType": "bytes32", "name": "protocolFees", "type": "bytes32" }
    ],
    "name": "Swap",
    "type": "event"
  }
]

// Full LBPair read ABI (price + reserves + swap event)
const ILBPair = [
  ...ILBPairSwap,
  {
    "inputs": [],
    "name": "getTokenX",
    "outputs": [{ "internalType": "address", "name": "tokenX", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getTokenY",
    "outputs": [{ "internalType": "address", "name": "tokenY", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getReserves",
    "outputs": [
      { "internalType": "uint128", "name": "reserveX", "type": "uint128" },
      { "internalType": "uint128", "name": "reserveY", "type": "uint128" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getActiveId",
    "outputs": [{ "internalType": "uint24", "name": "activeId", "type": "uint24" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint24", "name": "id", "type": "uint24" }],
    "name": "getPriceFromId",
    "outputs": [{ "internalType": "uint256", "name": "price", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  }
]

module.exports = {
  IAgniV3Pool,
  ILBPair,
  ILBPairSwap
}
