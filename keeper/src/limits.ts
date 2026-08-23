import { Contract, formatEther, parseEther, parseUnits, formatUnits } from "ethers";
import { CFG } from "./config.js";
import { provider, routerRead, factory, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { registry, type LimitOrder, type VaultRecord } from "./registry.js";
import { executeSwap, netOfExitCosts } from "./executor.js";
import { openPosition } from "./positions.js";
import { limitFires, db } from "./db.js";
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

/**
 * PLS per whole token, quoted fresh (not the polled price cache) - a
 * resting order should react to the price right now, not one up to
 * PRICE_POLL_SEC stale. Null if the token has no PulseX pair yet.
 *
 * Discounted by any measured sell tax on file, same fix as positions.ts's
 * markToMarket - getAmountsOut is pure reserve arithmetic with no idea a
 * token takes a cut on transfer, so an undiscounted quote overstates what a
 * real sale actually returns, and a sell-limit order is exactly a manual
 * take-profit target. This module deliberately runs no honeypot/tax
 * screening of its own (see the module comment), so `screened` frequently
 * has no row for a limit-order token at all - best-effort only: a token
 * this vault (or any other bot) has separately been screened for gets a
 * real discount, an unscreened one gets none, same "no fabricated numbers"
 * convention as executor.ts's own use of this table.
 */
async function currentPrice(token: string, decimals: number): Promise<number | null> {
  try {
    const pair: string = await factory.getPair(token, CFG.wpls);
    if (/^0x0{40}$/i.test(pair)) return null;
    const amounts: bigint[] = await routerRead.getAmountsOut(parseUnits("1", decimals), [token, CFG.wpls]);
    const quoted = amounts[amounts.length - 1] ?? 0n;
    const taxRow = db.prepare("SELECT sell_tax_bps FROM screened WHERE token = ?")
      .get(token.toLowerCase()) as { sell_tax_bps: number } | undefined;
    const taxBps = taxRow ? Math.min(taxRow.sell_tax_bps, 5000) : 0;
    const afterTax = (quoted * BigInt(10_000 - taxBps)) / 10_000n;
    return Number(formatEther(afterTax));
  } catch {
    return null;
  }
}

/**
 * What a real sell of `amountRaw` tokens would actually leave the vault
 * holding, in PLS per whole token - net of transfer tax AND the platform
 * fee/gas reimbursement a real BotVault.executeSwap exit pays on the way
 * out (see executor.ts's netOfExitCosts). The old currentPrice()-based sell
 * check compared a raw, cost-free per-unit quote against the target - the
 * same "roughly flat" read was already a small guaranteed loss the moment
 * the trade actually happened, same bug as positions.ts's markToMarket
 * (CLAUDE.md bug #6), just never fixed here because gas reimbursement is
 * close to a fixed PLS cost per trade rather than a pure percentage, so
 * what it comes out to per token depends on how many tokens are actually
 * being sold - there was no real total to net it out of until the caller
 * knows the real trade size. `amountRaw` must be the exact quantity this
 * order is actually about to sell (including a resolved sellAll balance),
 * not a placeholder 1-token probe.
 */
async function netSellPricePerUnit(token: string, decimals: number, amountRaw: bigint, vaultAddr: string): Promise<number | null> {
  try {
    const pair: string = await factory.getPair(token, CFG.wpls);
    if (/^0x0{40}$/i.test(pair)) return null;
    const amountWhole = Number(formatUnits(amountRaw, decimals));
    if (amountWhole <= 0) return null;
    const amounts: bigint[] = await routerRead.getAmountsOut(amountRaw, [token, CFG.wpls]);
    const quoted = amounts[amounts.length - 1] ?? 0n;
    const taxRow = db.prepare("SELECT sell_tax_bps FROM screened WHERE token = ?")
      .get(token.toLowerCase()) as { sell_tax_bps: number } | undefined;
    const taxBps = taxRow ? Math.min(taxRow.sell_tax_bps, 5000) : 0;
    const afterTax = (quoted * BigInt(10_000 - taxBps)) / 10_000n;
    const rawValuePls = Number(formatEther(afterTax));
    const netValuePls = await netOfExitCosts(rawValuePls, vaultAddr);
    return netValuePls / amountWhole;
  } catch {
    return null;
  }
}

async function fireOrder(v: VaultRecord, o: LimitOrder): Promise<void> {
  const token = o.token.toLowerCase();
  const decimals = await tokenDecimals(token);

  let amountIn: bigint;
  let path: string[];
  let firedPrice: number;

  if (o.side === "buy") {
    // Spend-side, not proceeds-shaped - the fee/gas the vault pays comes out
    // of the fixed o.amount PLS being spent, it doesn't change whether the
    // market price has hit the target, so no net-of-exit-costs treatment
    // needed here (same carve-out reasoning as the sell side used to have).
    const price = await currentPrice(token, decimals);
    if (price === null) return; // not tradeable right now, try again next tick
    if (price > o.targetPrice) return;
    if (o.amount <= 0) {
      log("warn", "limits", `${v.address} buy order ${o.id} on ${token} hit its target price (${price} <= ${o.targetPrice}) but has 0 PLS to spend - fix the amount on the dashboard`);
      return;
    }
    firedPrice = price;
    amountIn = parseEther(String(o.amount));
    path = [CFG.wpls, token];
  } else {
    // The real sell amount has to be known BEFORE the price check, not
    // after: gas reimbursement is close to a fixed PLS cost per trade, not
    // a pure percentage, so what it works out to per token depends on how
    // many tokens are actually being sold. A per-unit quote taken before
    // knowing the trade size (the old currentPrice()-based check) had no
    // real total to net that cost out of - see CLAUDE.md bug #6's carve-out
    // note. Determining raw first (including the sellAll balance read) lets
    // netSellPricePerUnit below quote and net costs against the REAL trade.
    let raw: bigint;
    if (o.sellAll) {
      const erc = new Contract(token, ERC20_ABI, provider) as Dyn;
      raw = await erc.balanceOf(v.address).catch(() => 0n);
      if (raw === 0n) return; // nothing to sell
    } else {
      if (o.amount <= 0) {
        log("warn", "limits", `${v.address} sell order ${o.id} on ${token} hit its target price but has 0 tokens to sell - fix the amount on the dashboard`);
        return;
      }
      raw = parseUnits(String(o.amount), decimals);
    }
    const netPrice = await netSellPricePerUnit(token, decimals, raw, v.address);
    if (netPrice === null) return; // not tradeable right now, try again next tick
    if (netPrice < o.targetPrice) return;
    firedPrice = netPrice;
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
    const priceNote = o.side === "sell" ? `net of fee/gas/tax` : `actual`;
    log("info", "limits", `${v.address} filled ${o.side} order on ${token}: ${amountLabel} at target ${o.targetPrice} PLS (${priceNote} ${firedPrice})`);

    // A buy fill was previously left completely untracked: the tokens landed
    // in the vault but never became a real position, so there was no P&L, no
    // Close Position button, nothing - the only way out was the dashboard's
    // manual emergency token withdraw. Same tracking every other bot's buys
    // already get, so the exact same Close Position / take-profit / stop-loss
    // machinery (see positions.ts) just works here too.
    if (o.side === "buy") {
      openPosition({
        vault: v.address, bot: "limit", token,
        spentPls: o.amount, tokensOut: res.amountOut,
        tpPct: o.takeProfitPct || 0, slPct: o.stopLossPct || 0, timeExitMin: 0,
        sourceTxHash: res.txHash,
      });
    }
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
