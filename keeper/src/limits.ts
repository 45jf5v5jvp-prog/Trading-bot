import { Contract, formatEther, parseEther, parseUnits, formatUnits } from "ethers";
import { CFG } from "./config.js";
import { provider, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { registry, type LimitOrder, type VaultRecord } from "./registry.js";
import { findBestVenue, findBestSellVenue } from "./venues.js";
import { executeSwap, executeSwapMultiVenue, type TradeVenue } from "./executor.js";
import { limitFires, db } from "./db.js";
import { log } from "./log.js";

/**
 * Resting buy/sell orders on a token the owner already holds or has
 * deposited themselves, checked across every venue (V2, V3, V4) - as
 * opposed to the Launch Bot (discovers new tokens) or Target Snipe (one
 * specific address, waiting to become tradeable for the first time). A
 * limit order assumes the token is ALREADY tradeable; it just waits for
 * the price, on whichever venue prices it best right now.
 *
 * No honeypot/age/deployer screening at all, deliberately more so than
 * even Target Snipe: this is a token the owner is choosing to hold and
 * already trusts. The safety net that still applies is the same one every
 * other trade path gets for free - executeSwap's/executeSwapMultiVenue's
 * pre-flight staticCall, which refuses to broadcast a transaction that
 * would revert.
 *
 * Every real ERC20 amount goes through the token's own `decimals()`
 * (parseUnits/formatUnits), never the 18-decimal-assuming parseEther/
 * formatEther the rest of this codebase uses for fresh launch tokens.
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

async function fireOrder(v: VaultRecord, o: LimitOrder): Promise<void> {
  const token = o.token.toLowerCase();
  const decimals = await tokenDecimals(token);

  let venue: Awaited<ReturnType<typeof findBestVenue>>;
  let amountIn: bigint;

  if (o.side === "buy") {
    if (o.amount <= 0) return;
    venue = await findBestVenue(token, o.amount);
    if (!venue) return; // not tradeable right now, try again next tick
    const price = o.amount / Number(formatUnits(venue.amountOut, decimals));
    if (price > o.targetPrice) return; // best price right now still above target
    amountIn = parseEther(String(o.amount));
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
    venue = await findBestSellVenue(token, raw);
    if (!venue) return;
    // venue.amountOut is pure quote arithmetic - it has no idea this token
    // might take a cut on transfer, so it overstates what a real sale
    // returns. A resting sell order is a manual take-profit target, so
    // deciding it's been hit on an untaxed quote is the same bug fixed in
    // positions.ts's markToMarket: discounted by any measured sell tax on
    // file (no screening runs for limit-order tokens by design - see the
    // module comment - so this is best-effort, same convention as
    // executor.ts's own use of this table).
    const taxRow = db.prepare("SELECT sell_tax_bps FROM screened WHERE token = ?")
      .get(token) as { sell_tax_bps: number } | undefined;
    const taxBps = taxRow ? Math.min(taxRow.sell_tax_bps, 5000) : 0;
    const afterTax = (venue.amountOut * BigInt(10_000 - taxBps)) / 10_000n;
    const price = Number(formatEther(afterTax)) / Number(formatUnits(raw, decimals));
    if (price < o.targetPrice) return; // best price right now still below target
    amountIn = raw;
  }

  // A vault can only execute on venues its implementation has functions
  // for - wait for a venue it CAN use, don't error.
  if (venue.kind === "v3" && v.kind !== "multiVenue" && v.kind !== "multiVenueV4") return;
  if (venue.kind === "v4" && v.kind !== "multiVenueV4") return;

  const tradeVenue: TradeVenue = venue.kind === "v2"
    ? { kind: "v2", path: o.side === "buy" ? [CFG.weth, token] : [token, CFG.weth] }
    : venue.kind === "v3"
    ? (o.side === "buy"
        ? { kind: "v3", tokenIn: CFG.weth, tokenOut: token, fee: venue.fee }
        : { kind: "v3", tokenIn: token, tokenOut: CFG.weth, fee: venue.fee })
    : { kind: "v4", key: venue.key, buy: o.side === "buy" };

  const res = venue.kind === "v2" && v.kind === "v2"
    ? await executeSwap({ vault: v.address, bot: "limit", path: (tradeVenue as { kind: "v2"; path: string[] }).path, amountIn, tokenLabel: token, slippageBps: CFG.maxSlippageBps })
    : await executeSwapMultiVenue({ vault: v.address, bot: "limit", venue: tradeVenue, amountIn, tokenLabel: token, slippageBps: CFG.maxSlippageBps });

  if (res.ok) {
    limitFires.record(v.address, o.id, res.txHash);
    const amountLabel = o.side === "buy" ? `${o.amount} ETH` : `${formatUnits(amountIn, decimals)} tokens`;
    log("info", "limits", `${v.address} filled ${o.side} order on ${token} via ${venue.kind}: ${amountLabel} at target ${o.targetPrice} ETH`);
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
