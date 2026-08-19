export const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
  "function factory() view returns (address)",
];

export const FACTORY_ABI = [
  "function getPair(address a, address b) view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
];

export const PAIR_ABI = [
  "function getReserves() view returns (uint112 r0, uint112 r1, uint32 ts)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function owner() view returns (address)",
];

export const VAULT_ABI = [
  "function owner() view returns (address)",
  "function executor() view returns (address)",
  "function paused() view returns (bool)",
  "function maxTradeSize() view returns (uint256)",
  "function maxGasFee() view returns (uint256)",
  "function maxGasFeeBps() view returns (uint16)",
  "function minInterval() view returns (uint256)",
  "function lastTradeAt() view returns (uint256)",
  "function executeSwap(address[] path, uint256 amountIn, uint256 amountOutMin, uint256 gasFee) returns (uint256)",
];

export const VAULT_FACTORY_ABI = [
  "function vaultCount() view returns (uint256)",
  "function allVaults(uint256) view returns (address)",
  "function vaultOf(address) view returns (address)",
  "event VaultCreated(address indexed user, address vault)",
];

/// MultiVenueVault (contracts/MultiVenueVault.sol) shares owner/executor/
/// paused/maxTradeSize/maxGasFee/maxGasFeeBps/minInterval/lastTradeAt with
/// BotVault under identical names, so VAULT_ABI above already covers reading
/// those. This is just the two swap entry points that differ.
export const MULTI_VENUE_VAULT_ABI = [
  "function executeSwapV2(address[] path, uint256 amountIn, uint256 amountOutMin, uint256 gasFee) returns (uint256)",
  "function executeSwapV3(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 amountOutMin, uint256 gasFee) returns (uint256)",
];

export const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];

export const V3_POOL_ABI = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

/// QuoterV2's common shape - verify this matches whatever Quoter is actually
/// deployed on Robinhood Chain before trusting it (same caution as
/// MultiVenueVault.sol's open question #2 on the router shape).
export const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

/// Uniswap V4 singleton PoolManager - only the one event the scanner needs.
/// Every V4 pool announces itself here at creation; there are no per-pool
/// contracts to discover. PoolId is bytes32, Currency and IHooks are
/// address-backed value types, so they appear as their underlying ABI types.
export const V4_POOL_MANAGER_ABI = [
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
];

/// SwapProbeV4 (contracts/SwapProbeV4.sol) - the keeper's own V4 periphery.
/// quote() prices without funds (simulate-and-revert internally); probe()
/// runs the real buy+sell honeypot check under eth_call.
export const V4_PROBE_ABI = [
  "function quote((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint256 amountIn) returns (uint256 amountOut)",
  "function probe((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) payable returns ((bool buyOk, bool sellOk, uint256 actualOut, uint256 ethReturned, uint256 roundTripLossBps) r)",
];

/// MultiVenueVaultV4 (contracts/MultiVenueVaultV4.sol) shares everything
/// VAULT_ABI and MULTI_VENUE_VAULT_ABI already cover; this is only the V4
/// entry point that's new to it.
export const MULTI_VENUE_V4_VAULT_ABI = [
  "function executeSwapV4((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool buy, uint256 amountIn, uint256 amountOutMin, uint256 gasFee) returns (uint256)",
];
