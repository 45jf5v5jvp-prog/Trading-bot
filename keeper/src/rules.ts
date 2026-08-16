import { parseEther, formatEther } from "ethers";
import { CFG } from "./config.js";
import { registry, type TradingRule, type VaultRecord } from "./registry.js";
import { windowStats, coverageHours, ensureWatched } from "./prices.js";
import { executeSwap } from "./executor.js";
import { positionsValuePls } from "./positions.js";
import { recordBuy, exceedsHoldingCap } from "./portfolio.js";
import { mapLimit } from "./concurrency.js";
import { db } from "./db.js";
import { log } from "./log.js";

/** Fires by this vault, this bot, this token, since a timestamp. */
function recentFires(vault: string, token: string, sinceTs: number): number {
  const r = db.prepare(
    `SELECT COUNT(*) n FROM fires WHERE vault=? AND token=? AND bot='trading' AND ts>=?`,
  ).get(vault.toLowerCase(), token.toLowerCase(), sinceTs) as { n: number };
  return r.n;
}

function lastFireTs(vault: string, token: string): number {
  const r = db.prepare(
    `SELECT MAX(ts) t FROM fires WHERE vault=? AND token=? AND bot='trading'`,
  ).get(vault.toLowerCase(), token.toLowerCase()) as { t: number | null };
  return r.t ?? 0;
}

async function vaultPlsBalance(vault: string): Promise<bigint> {
  const { provider } = await import("./chain.js");
  const { Contract } = await import("ethers");
  const { ERC20_ABI } = await import("./abis.js");
  const weth = new Contract(CFG.weth, ERC20_ABI, provider) as any;
  return weth.balanceOf(vault);
}

export async function evaluate(rule: TradingRule, v: VaultRecord): Promise<void> {
  const token = rule.token.toLowerCase();

  if (!(await ensureWatched(token))) return;

  // The history gate. A rule cannot arm until the series covers its lookback.
  const have = coverageHours(token);
  if (have < rule.lookbackHours) {
    log("debug", "rules", `${v.address} ${token} needs ${rule.lookbackHours}h, has ${have.toFixed(1)}h`);
    return;
  }

  const w = windowStats(token, rule.lookbackHours);
  if (!w) return;

  const move = rule.direction === "drops"
    ? (w.high - w.last) / w.high
    : (w.last - w.low) / w.low;
  if (move * 100 < rule.thresholdPct) return;

  const now = Math.floor(Date.now() / 1000);
  const since = lastFireTs(v.address, token);
  if (now - since < rule.cooldownHours * 3600) return;
  if (recentFires(v.address, token, now - 86400) >= rule.maxFires) {
    log("debug", "rules", `${v.address} ${token} hit daily fire cap`);
    return;
  }

  const bal = await vaultPlsBalance(v.address);
  const amountIn = (bal * BigInt(Math.round(rule.allocPct * 100))) / 10_000n;
  if (amountIn === 0n) return;

  // Holding cap. Convert every figure to a PLS value, then ask whether this buy
  // would push the token above its allowed share of the whole vault. This is the
  // guard that stops a dip-buying rule pouring the entire vault into one token.
  const buyPls = Number(formatEther(amountIn));
  const { total: posValue, byToken } = await positionsValuePls(v.address);
  const totalValue = Number(formatEther(bal)) + posValue;
  const tokenNow = byToken.get(token) ?? 0;
  if (exceedsHoldingCap(tokenNow + buyPls, totalValue, v.maxHoldingPct)) {
    log("info", "rules", `${v.address} ${token}: holding cap ${v.maxHoldingPct}% would be exceeded ` +
      `(${(tokenNow + buyPls).toFixed(0)}/${totalValue.toFixed(0)} PLS), skipping buy`);
    return;
  }

  log("info", "rules", `Trigger: ${token} ${rule.direction} ${(move * 100).toFixed(2)}% ` +
    `over ${rule.lookbackHours}h, buying ${formatEther(amountIn)} PLS for ${v.address}`);

  const res = await executeSwap({
    vault: v.address,
    bot: "trading",
    path: [CFG.weth, token],
    amountIn,
    tokenLabel: token,
  });
  if (!res.ok) { log("warn", "rules", `Skipped: ${res.reason}`); return; }

  // Track the buy so the sell side (take profit / stop loss / trailing / time)
  // actually fires. Multiple buys of the same token blend into one position.
  recordBuy({
    vault: v.address, token, spentPls: buyPls, tokensOut: res.amountOut,
    targets: {
      tpPct: rule.takeProfitPct, slPct: rule.stopLossPct,
      trailPct: rule.trailingStopPct, timeExitMin: rule.timeExitMin,
    },
  });
}

/**
 * Checks every active vault's rules. Vaults run concurrently (bounded by
 * KEEPER_CONCURRENCY) since they are fully independent - different balances,
 * different positions, nothing shared between them. A single vault's own rules
 * stay sequential, in order, so two rules on the same vault never race each
 * other reading its balance before either has traded.
 */
export async function tick(): Promise<void> {
  await mapLimit(registry.active(), CFG.keeperConcurrency, async (v) => {
    for (const rule of v.rules) {
      try { await evaluate(rule, v); }
      catch (e) { log("error", "rules", `${v.address}: ${(e as Error).message}`); }
    }
  });
}

export { parseEther };
