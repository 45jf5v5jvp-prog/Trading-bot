// Chain-independent contract surface. All addresses and chain identity come
// from lib/chain.js (one preset per deployment); the ABIs below are identical
// on every chain because both deployments run the same contract family.
import chain from "./chain";

export const CHAIN = chain.CHAIN;
export const CHAIN_ID = CHAIN.chainId;
export const RPC_URL = CHAIN.rpcUrl;
export const VAULT_FACTORY = CHAIN.vaultFactory;
// V2+V3 capable vaults (MultiVenueVault). Blank on chains where that factory
// is not deployed - the site then stays on V2-only vaults exactly as before.
export const MULTI_VENUE_VAULT_FACTORY = CHAIN.multiVenueVaultFactory;
// The wrapped native token (WPLS on PulseChain, WETH on Robinhood Chain).
export const WRAPPED = CHAIN.wrapped;
export const ROUTER = CHAIN.router;
export const EXPLORER_URL = CHAIN.explorerUrl;

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
  "function withdrawAll(address[] tokens)",
  "function setPaused(bool p)",
  "function revokeExecutor()",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

export const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] memory)",
];
