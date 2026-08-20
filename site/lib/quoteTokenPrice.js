import { JsonRpcProvider, Contract, formatEther, parseUnits } from "ethers";
import { RPC_URL, ROUTER, ROUTER_ABI, WRAPPED, ERC20_ABI } from "./contracts";

let providerSingleton;
function getProvider() {
  if (!providerSingleton) providerSingleton = new JsonRpcProvider(RPC_URL);
  return providerSingleton;
}

/**
 * Live price of one whole token in the chain's base currency, quoted
 * straight off the V2 router - a lightweight one-off read for the limit
 * order editor's "% from current price" mode, not a tracked/polled value.
 * Same V2-only limitation as the rest of this app's live-price plumbing
 * (lib/livePrice.js) - a token that's only ever traded on V3/V4 won't
 * price here. Throws on any failure; the caller decides how to show that.
 */
export async function quoteTokenPrice(token) {
  const provider = getProvider();
  const erc = new Contract(token, ERC20_ABI, provider);
  const router = new Contract(ROUTER, ROUTER_ABI, provider);
  const decimals = await erc.decimals();
  const amounts = await router.getAmountsOut(parseUnits("1", decimals), [token, WRAPPED]);
  return Number(formatEther(amounts[amounts.length - 1]));
}
