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
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
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
