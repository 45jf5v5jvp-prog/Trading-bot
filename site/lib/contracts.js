// Real deployed PulseChain addresses for this project. No simulated data here -
// every read in the dashboard goes through these against the actual chain.
export const CHAIN_ID = 369;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.pulsechain.com";
export const VAULT_FACTORY = process.env.NEXT_PUBLIC_VAULT_FACTORY || "0xf1971425f3F52f6E6e6058Ba7faB5eF446fc7295";
export const WPLS = process.env.NEXT_PUBLIC_WPLS || "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
// Same PulseX V2 router the keeper itself trades through (keeper/.env ROUTER) -
// used here read-only, just to price open positions live.
export const ROUTER = process.env.NEXT_PUBLIC_ROUTER || "0x165C3410fC91EF562C50559f7d2289fEbed552d9";

export const VAULT_FACTORY_ABI = [
  "function vaultOf(address) view returns (address)",
  "function vaultCount() view returns (uint256)",
  "function createVault(address[] tokens) returns (address)",
];

export const VAULT_ABI = [
  "function owner() view returns (address)",
  "function executor() view returns (address)",
  "function paused() view returns (bool)",
  "function maxTradeSize() view returns (uint256)",
  "function minInterval() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount)",
  "function setPaused(bool p)",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

export const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] memory)",
];
