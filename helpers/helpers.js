const ethers = require("ethers")
const Big = require("big.js")

const { IAgniV3Pool, ILBPair } = require("./abi")
const IERC20 = require("@openzeppelin/contracts/build/contracts/ERC20.json")

async function getTokenAndContract(_token0Address, _token1Address, _provider) {
  const token0Contract = new ethers.Contract(_token0Address, IERC20.abi, _provider)
  const token1Contract = new ethers.Contract(_token1Address, IERC20.abi, _provider)

  const token0 = {
    contract: token0Contract,
    address: _token0Address,
    symbol: await token0Contract.symbol(),
    decimals: Number(await token0Contract.decimals()),
  }

  const token1 = {
    contract: token1Contract,
    address: _token1Address,
    symbol: await token1Contract.symbol(),
    decimals: Number(await token1Contract.decimals()),
  }

  return { token0, token1 }
}

async function getPoolAddress(_exchange, _token0, _token1, _feeOrBinStep) {
  if (_exchange.type === "V3") {
    return await _exchange.factory.getPool(_token0, _token1, _feeOrBinStep)
  }

  if (_exchange.type === "LB") {
    const info = await _exchange.factory.getLBPairInformation(_token0, _token1, _feeOrBinStep)
    return info.LBPair
  }

  throw new Error(`Unknown exchange.type: ${_exchange.type}`)
}

async function getPoolContract(_exchange, _token0, _token1, _feeOrBinStep, _provider) {
  const poolAddress = await getPoolAddress(_exchange, _token0, _token1, _feeOrBinStep)

  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    // Scan binSteps for LB if pool not found
    if (_exchange.type === "LB") {
      console.log(`\n🔍 Scanning ${_exchange.name} binSteps...`)
      for (const step of [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 100]) {
        try {
          const info = await _exchange.factory.getLBPairInformation(_token0, _token1, step)
          if (info.LBPair !== ethers.ZeroAddress) {
            console.log(`  ✅ FOUND | binStep=${step} | ${info.LBPair}`)
          }
        } catch (_) { /* skip */ }
      }
      console.log("🔍 Scan complete\n")
    }

    throw new Error(`Pool not found (address=0). Check fee/binStep for ${_exchange.name}.`)
  }

  // LB pool (Merchant Moe)
  if (_exchange.type === "LB") {
    return new ethers.Contract(poolAddress, ILBPair, _provider)
  }

  // V3 pool (Agni) — standard Uniswap V3 ABI
  return new ethers.Contract(poolAddress, IAgniV3Pool, _provider)
}

async function getPoolLiquidity(_exchange, _token0, _token1, _feeOrBinStep, _provider) {
  const pool = await getPoolContract(_exchange, _token0.address, _token1.address, _feeOrBinStep, _provider)
  const poolAddress = await pool.getAddress()

  if (_exchange.type === "LB") {
    const [reserveX, reserveY] = await pool.getReserves()
    const tokenX = (await pool.getTokenX()).toLowerCase()
    const tokenY = (await pool.getTokenY()).toLowerCase()

    if (_token0.address.toLowerCase() === tokenX && _token1.address.toLowerCase() === tokenY) {
      return [reserveX, reserveY]
    } else if (_token0.address.toLowerCase() === tokenY && _token1.address.toLowerCase() === tokenX) {
      return [reserveY, reserveX]
    }
    return [reserveX, reserveY]
  }

  // V3: token balances at pool address
  const token0Balance = await _token0.contract.balanceOf(poolAddress)
  const token1Balance = await _token1.contract.balanceOf(poolAddress)
  return [token0Balance, token1Balance]
}

async function calculatePrice(_pool, _token0, _token1) {
  const hasGetActiveId = typeof _pool.getActiveId === "function"

  // ── Merchant Moe LB price (128.128 fixed-point) ──
  if (hasGetActiveId) {
    const tokenX = (await _pool.getTokenX()).toLowerCase()
    const tokenY = (await _pool.getTokenY()).toLowerCase()

    let activeId, priceX128
    try {
      activeId = await _pool.getActiveId()
      priceX128 = await _pool.getPriceFromId(activeId)
    } catch (err) {
      return null // bin moved mid-block
    }

    if (!priceX128) return null

    const raw = Big(priceX128.toString()).div(Big(2).pow(128)) // y/x in smallest units

    const t0 = _token0.address.toLowerCase()
    const t1 = _token1.address.toLowerCase()

    if (t0 === tokenX && t1 === tokenY) {
      const scale = Big(10).pow(_token0.decimals - _token1.decimals)
      return raw.mul(scale)
    }

    if (t0 === tokenY && t1 === tokenX) {
      const inv = Big(1).div(raw)
      const scale = Big(10).pow(_token0.decimals - _token1.decimals)
      return inv.mul(scale).toString()
    }

    return raw.toString()
  }

  // ── Agni V3 price (sqrtPriceX96) ──
  // V3 sqrtPriceX96² / 2^192 = pool_token1 / pool_token0 (raw units)
  // pool_token0 = lower address. Must check if our _token0 matches.
  const [sqrtPriceX96] = await _pool.slot0()
  const poolToken0 = (await _pool.token0()).toLowerCase()

  const sqrt = Big(sqrtPriceX96.toString())
  const rawPrice = sqrt.mul(sqrt).div(Big(2).pow(192))

  const t0 = _token0.address.toLowerCase()

  if (t0 === poolToken0) {
    // Our _token0 = pool_token0, our _token1 = pool_token1
    // rawPrice is already _token1_raw / _token0_raw — just scale for decimals
    const scale = Big(10).pow(_token0.decimals - _token1.decimals)
    return rawPrice.mul(scale).toString()
  } else {
    // Our _token0 = pool_token1, our _token1 = pool_token0
    // rawPrice is _token0_raw / _token1_raw — need to invert
    const inv = Big(1).div(rawPrice)
    const scale = Big(10).pow(_token0.decimals - _token1.decimals)
    return inv.mul(scale).toString()
  }
}

async function calculateDifference(_uPrice, _sPrice) {
  return (((_uPrice - _sPrice) / _sPrice) * 100).toFixed(2)
}

module.exports = {
  getTokenAndContract,
  getPoolAddress,
  getPoolContract,
  getPoolLiquidity,
  calculatePrice,
  calculateDifference,
}
