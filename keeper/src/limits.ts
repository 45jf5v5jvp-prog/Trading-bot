import { Contract, formatEther, parseEther, parseUnits, formatUnits } from "ethers";
import { CFG } from "./config.js";
import { provider, routerRead, factory, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { registry, type LimitOrder, type VaultRecord } from "./registry.js";
import { executeSwap } from "./executor.js";
import { limitFires } from "./db.js";
import { log } from "./log.js";

/**
 * Resting buy/sell orders on a token the owner already holds or has
 * deposited themselves - HEX, INC, PLSX, whatever - as opposed to the
 * Launch Bot (discovers new tokens) or Target Snipe (one specific address,
 * waiting for it to become tradeable for the first time). A limit order
 * assumes the token is ALREADY tradeable; it just waits for the price.
 *
 * No honeypot/age/deployer screening here at all, deliberately more so than
 * even Target Snipe: this is a token the owner is choosing to hold and
 * already trusts, often one they deposited directly into the vault by
 * wallet transfer. The safety net that still applies is the same one every
 * other trade path gets for free - executeSwap's pre-flight staticCall,
 * which refuses to broadcast a transaction that would revert.
 *
 * Every real ERC20 amount here goes through the token's own `decimals()`
 * (parseUnits/formatUnits), never the 18-decimal-assuming parseEther/
 * formatEther the rest of this codebase uses for fresh launch tokens - HEX
 * is 8 decimals, and getting that wrong is a 10-billion-times error, not a
 * rounding one.
 */

const decimalsCache = new Map<string, number>();

async function tokenDecimals(token: string): Promise<number> {
  const key = token.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const erc = new Contract(token, ERC20_ABI, provider) as Dyn;
  const dec = Number(await erc.decimals().catch(() => 18));
  decimalsCache.set(key, dec);
  return dec;
}

/** PLS per whole token, quoted fresh (not the polled price cache) - a
 * resting order should react to the price right now, not one up to
 * PRICE_POLL_SEC stale. Null if the token has no PulseX pair yet. */
async function currentPrice(token: string, decimals: number): Promise<number | null> {
  try {
    const pair: string = await factory.getPair(token, CFG.wpls);
    if (/^0x0{40}$/i.test(pair)) return null;
    const amounts: bigint[] = await routerRead.getAmountsOut(parseUnits("1", decimals), [token, CFG.wpls]);
    return Number(formatEther(amounts[amounts.length - 1] ?? 0n));
  } catch {
    return null;
  }
}

async function fireOrder(v: VaultRecord, o: LimitOrder): Promise<void> {
  const token = o.token.toLowerCase();
  const decimals = await tokenDecimals(token);
  const price = await currentPrice(token, decimals);
  if (price === null) return; // not tradeable right now, try again next tick

  const shouldFire = o.side === "buy" ? price <= o.targetPrice : price >= o.targetPrice;
  if (!shouldFire) return;

  let amountIn: bigint;
  let path: string[];
  if (o.side === "buy") {
    if (o.amount <= 0) return;
    amountIn = parseEther(String(o.amount));
    path = [CFG.wpls, token];
  } else {
    let raw: bigint;
    if (o.sellAll) {
      const erc = new Contract(token, ERC20_ABI, provider) as Dyn;
      raw = await erc.balanceOf(v.address).catch(() => 0n);
      if (raw === 0n) return; // nothing to sell
    } else {
      if (o.amount <= 0) return;
      raw = parseUnits(String(o.amount), decimals);
    }
    amountIn = raw;
    path = [token, CFG.wpls];
  }

  const res = await executeSwap({
    vault: v.address, bot: "limit", path, amountIn, tokenLabel: token,
    slippageBps: CFG.maxSlippageBps,
  });

  if (res.ok) {
    limitFires.record(v.address, o.id, res.txHash);
    const amountLabel = o.side === "buy" ? `${o.amount} PLS` : `${formatUnits(amountIn, decimals)} tokens`;
    log("info", "limits", `${v.address} filled ${o.side} order on ${token}: ${amountLabel} at target ${o.targetPrice} PLS (actual ${price})`);
  } else {
    log("warn", "limits", `${v.address} ${o.side} order on ${token} not filled: ${res.reason}`);
  }
}

export async function tick(): Promise<void> {
  for (const v of registry.active()) {
    for (const o of v.limitOrders) {
      if (limitFires.has(v.address, o.id)) continue;
      try {
        await fireOrder(v, o);
      } catch (e) {
        log("error", "limits", `${v.address} order ${o.id} on ${o.token}: ${(e as Error).message}`);
      }
    }
  }
}
