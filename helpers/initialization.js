require("dotenv").config()
const ethers = require("ethers")

const config = require("../config.json")

// Agni Finance = Uniswap V3 fork — uses standard V3 ABIs
const IUniswapV3Factory = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json")
const IQuoter = require("@uniswap/v3-periphery/artifacts/contracts/interfaces/IQuoterV2.sol/IQuoterV2.json")
const ISwapRouter = require("@uniswap/v3-periphery/artifacts/contracts/interfaces/ISwapRouter.sol/ISwapRouter.json")

// ── HTTP-only provider (stable for logging) ─────────────
const HTTP_URL = config.RPC.HTTP
const provider = new ethers.JsonRpcProvider(HTTP_URL)
console.log(`✅ Connected via HTTP: ${HTTP_URL}`)

// ── Merchant Moe LB Factory ABI ─────────────────────────
const ILBFactory_ABI = [
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "uint256", name: "binStep", type: "uint256" }
    ],
    name: "getLBPairInformation",
    outputs: [
      {
        components: [
          { internalType: "uint16",  name: "binStep",         type: "uint16" },
          { internalType: "address", name: "LBPair",          type: "address" },
          { internalType: "bool",    name: "createdByOwner",  type: "bool" },
          { internalType: "bool",    name: "ignoredForRouting", type: "bool" }
        ],
        internalType: "struct ILBFactory.LBPairInformation",
        name: "lbPairInformation",
        type: "tuple"
      }
    ],
    stateMutability: "view",
    type: "function"
  }
]

// ── Exchange objects ────────────────────────────────────

const merchantmoe = {
  type: "LB",
  name: "Merchant Moe LB",
  factory: new ethers.Contract(config.MERCHANTMOE.FACTORY, ILBFactory_ABI, provider),
}

const agni = {
  type: "V3",
  name: "Agni Finance V3",
  factory: new ethers.Contract(config.AGNI.FACTORY, IUniswapV3Factory.abi, provider),
  quoter:  new ethers.Contract(config.AGNI.QUOTER_V2, IQuoter.abi, provider),
  router:  new ethers.Contract(config.AGNI.ROUTER, ISwapRouter.abi, provider),
}

module.exports = {
  provider,
  merchantmoe,
  agni,
}
