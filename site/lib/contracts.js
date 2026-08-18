// Real deployed Robinhood Chain addresses for this project. No simulated data
// here - every read in the dashboard goes through these against the actual chain.
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "4663");
// No safe public default exists for this chain (unlike PulseChain's
// rpc.pulsechain.com) - this is bundled into the browser JS, so it must NOT be
// a URL with a private API key embedded (that would leak the key to every
// visitor). Use a separate, domain-restricted RPC key for this specifically.
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "";
export const VAULT_FACTORY = process.env.NEXT_PUBLIC_VAULT_FACTORY || "0xfe0EC05B62fD5EA170Cbb40706CD088DB8E06D54";
// V2+V3 capable vaults (contracts/MultiVenueVault.sol). Blank until deployed
// and verified - see CLAUDE.md. When set, new vaults are created here
// instead of the V2-only factory above; existing V2-only vaults are
// unaffected and keep working exactly as they do today.
export const MULTI_VENUE_VAULT_FACTORY = process.env.NEXT_PUBLIC_MULTI_VENUE_VAULT_FACTORY || "";
export const WETH = process.env.NEXT_PUBLIC_WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
// Same router the keeper itself trades through (keeper/.env ROUTER) - used
// here read-only, just to price open positions live.
export const ROUTER = process.env.NEXT_PUBLIC_ROUTER || "0x89e5db8b5aa49aa85ac63f691524311aeb649eba";
// Optional: a verified Robinhood Chain block explorer, for linking tx hashes.
// Left blank until one is independently confirmed (see keeper/src/config.ts's
// note on hoodexplorer.org being unconfirmed) - tx hashes display as plain
// text with no link until this is set.
export const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL || "";

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
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

export const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] memory)",
];
