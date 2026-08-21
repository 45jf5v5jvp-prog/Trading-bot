import { Contract, formatEther, parseEther } from "ethers";
import { CFG } from "./config.js";
import { provider, factory, type Dyn } from "./chain.js";
import { FACTORY_ABI, ERC20_ABI } from "./abis.js";
import { registry, type VaultRecord } from "./registry.js";
import { screen, recordScreen } from "./screener.js";
import { executeSwap } from "./executor.js";
import { openPosition, positionsValuePls } from "./positions.js";
import { exceedsHoldingCap } from "./portfolio.js";
import { ensureWatched } from "./prices.js";
import { mapLimit } from "./concurrency.js";
import { db, meta } from "./db.js";
import { log } from "./log.js";

/** WPLS the vault currently holds, in whole PLS. */
export async function vaultWplsPls(vault: string): Promise<number> {
  const wpls = new Contract(CFG.wpls, ERC20_ABI, provider) as Dyn;
  return Number(formatEther(await wpls.balanceOf(vault)));
}

/**
 * Watches PulseX for new pairs and hands each one to the screener.
 *
 * Scans by block range rather than a live subscription. Public PulseChain RPCs
 * drop websocket connections regularly, and a missed PairCreated event is a
 * missed launch with no way to notice. Polling ranges is slower by a few
 * seconds and never silently loses anything.
 */

const seen = new Set<string>();

// PairCreated fires when the pair is CREATED, which is sometimes a separate
// transaction from the one that adds liquidity. A token screened in that gap
// shows liquidity 0, gets rejected "below floor", and used to stay rejected
// forever because the seen-set never gives a token a second look. On a fresh
// launch the liquidity is often still on its way, so a liquidity rejection
// goes on this re-check list and gets another screen each scan pass until
// the window expires.
const LOW_LIQ_RETRY_MS = 30 * 60 * 1000;
const RETRY_MIN_GAP_MS = 60 * 1000;
const pendingRetry = new Map<string, { pair: string; txHash: string; firstSeenMs: number; lastTriedMs: number }>();

function queueRetry(token: string, pair: string, txHash: string): void {
  const key = token.toLowerCase();
  if (pendingRetry.has(key)) {
    pendingRetry.get(key)!.lastTriedMs = Date.now();
    return;
  }
  pendingRetry.set(key, { pair, txHash, firstSeenMs: Date.now(), lastTriedMs: Date.now() });
  log("info", "launch", `${token}: liquidity below floor on a fresh pair - re-checking for ${LOW_LIQ_RETRY_MS / 60000} min in case liquidity is still arriving`);
}

async function retryPendingTokens(): Promise<void> {
  for (const [key, p] of [...pendingRetry]) {
    if (Date.now() - p.firstSeenMs > LOW_LIQ_RETRY_MS) {
      pendingRetry.delete(key);
      log("info", "launch", `Gave up on ${key}: liquidity never reached the floor within ${LOW_LIQ_RETRY_MS / 60000} min`);
      continue;
    }
    if (Date.now() - p.lastTriedMs < RETRY_MIN_GAP_MS) continue;
    p.lastTriedMs = Date.now();
    await evaluateToken(key, p.pair, p.txHash);
  }
}

function firesToday(vault: string): number {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const r = db.prepare(`SELECT COUNT(*) n FROM fires WHERE vault=? AND bot='launch' AND ts>=?`)
    .get(vault.toLowerCase(), since) as { n: number };
  return r.n;
}

async function deployerOf(txHash: string): Promise<string | null> {
  try {
    const tx = await provider.getTransaction(txHash);
    return tx?.from ?? null;
  } catch { return null; }
}

async function handleNewPair(token: string, pair: string, txHash: string): Promise<void> {
  if (seen.has(token.toLowerCase())) return;
  seen.add(token.toLowerCase());
  log("info", "launch", `New pair ${pair} for token ${token}`);
  // Unconditional and independent of Launch Bot config or screening outcome -
  // Discovery Bot needs price/liquidity history for every token PulseX ever
  // lists, not just the ones some vault's Launch Bot happens to be watching
  // for and that pass its screen. See prices.ts's ensureWatched.
  await ensureWatched(token);
  await evaluateToken(token, pair, txHash);
}

async function evaluateToken(token: string, pair: string, txHash: string): Promise<void> {
  const candidates = registry.active().filter((v) => v.launch.enabled && v.launch.perLaunchPls > 0);
  if (candidates.length === 0) return;

  const deployer = await deployerOf(txHash);

  // Screen once with the strictest limits any subscriber uses, then let each
  // vault apply its own thresholds to the result. One simulation, not N.
  const strictest = {
    maxBuyTaxBps: Math.max(...candidates.map((c) => c.launch.maxBuyTaxBps)),
    maxSellTaxBps: Math.max(...candidates.map((c) => c.launch.maxSellTaxBps)),
    requireLpLock: candidates.every((c) => c.launch.requireLpLock),
    maxDeployerPct: Math.max(...candidates.map((c) => c.launch.maxDeployerPct)),
    minLiquidityPls: Math.min(...candidates.map((c) => c.launch.minLiquidityPls)),
    requireOwnerRenounced: candidates.every((c) => c.launch.requireOwnerRenounced),
  };

  const s = await screen(token, deployer, strictest);
  recordScreen(s);

  if (!s.sellable) {
    log("info", "launch", `Rejected ${token}: ${s.reason}`);
    if (/below floor/i.test(s.reason)) queueRetry(token, pair, txHash);
    else pendingRetry.delete(token.toLowerCase());
    return;
  }
  pendingRetry.delete(token.toLowerCase());
  log("info", "launch", `Screened ${token}: buyTax ${s.buyTaxBps}bps sellTax ${s.sellTaxBps}bps ` +
    `lp ${s.lpLockedPct.toFixed(0)}% deployer ${s.deployerPct.toFixed(0)}% liq ${Math.round(s.liqPls)} PLS`);

  // Each candidate vault gets exactly one buy-or-skip decision here, and
  // vaults are independent, so this runs concurrently (bounded by
  // KEEPER_CONCURRENCY) rather than one vault at a time - a hot launch with
  // many subscribers should not queue up behind a slow RPC round trip per vault.
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const L = v.launch;
    // Every one of these was a silent `return` with nothing to show for it -
    // a token that passed the shared screen could still get rejected here by
    // one vault's own stricter settings, and there was no way to tell that
    // had even happened short of reading this source file. Logged now so a
    // vault that "never buys anything" is diagnosable from its own logs
    // instead of a guess (see keeper.db's `screened` table for the shared
    // screen's own pass/fail, which this sits downstream of).
    if (firesToday(v.address) >= L.maxPerDay) {
      log("info", "launch", `${v.address} ${token}: already hit its ${L.maxPerDay}/day launch cap, skipping`);
      return;
    }
    if (s.buyTaxBps > L.maxBuyTaxBps) {
      log("info", "launch", `${v.address} ${token}: buy tax ${(s.buyTaxBps / 100).toFixed(1)}% over this vault's ${(L.maxBuyTaxBps / 100).toFixed(1)}% limit, skipping`);
      return;
    }
    if (s.sellTaxBps > L.maxSellTaxBps) {
      log("info", "launch", `${v.address} ${token}: sell tax ${(s.sellTaxBps / 100).toFixed(1)}% over this vault's ${(L.maxSellTaxBps / 100).toFixed(1)}% limit, skipping`);
      return;
    }
    if (L.requireLpLock && s.lpLockedPct < 95) {
      log("info", "launch", `${v.address} ${token}: only ${s.lpLockedPct.toFixed(1)}% of LP is locked or burned and this vault requires LP lock, skipping`);
      return;
    }
    if (s.deployerPct > L.maxDeployerPct) {
      log("info", "launch", `${v.address} ${token}: deployer holds ${s.deployerPct.toFixed(1)}% of supply, over this vault's ${L.maxDeployerPct}% limit, skipping`);
      return;
    }
    if (s.liqPls < L.minLiquidityPls) {
      log("info", "launch", `${v.address} ${token}: liquidity ${Math.round(s.liqPls)} PLS below this vault's ${L.minLiquidityPls} PLS floor, skipping`);
      return;
    }
    if (L.requireOwnerRenounced && !s.ownerRenounced) {
      log("info", "launch", `${v.address} ${token}: owner has not renounced control and this vault requires it, skipping`);
      return;
    }

    // Holding cap, same guard the rule bot uses. A fresh launch token has no
    // position yet, so its current value is whatever the vault already bought.
    const { total: posValue, byToken } = await positionsValuePls(v.address);
    const totalValue = (await vaultWplsPls(v.address)) + posValue;
    const tokenNow = byToken.get(token.toLowerCase()) ?? 0;
    if (exceedsHoldingCap(tokenNow + L.perLaunchPls, totalValue, v.maxHoldingPct)) {
      log("info", "launch", `${v.address} ${token}: holding cap ${v.maxHoldingPct}% would be exceeded, skipping`);
      return;
    }

    const amountIn = parseEther(String(L.perLaunchPls));
    const res = await executeSwap({
      vault: v.address, bot: "launch", path: [CFG.wpls, token],
      amountIn, tokenLabel: token,
      // New pairs move violently in the first blocks. Tighter than the default
      // means more skipped fills and fewer terrible ones.
      slippageBps: Math.min(CFG.maxSlippageBps, 300),
    });

    if (res.ok) {
      openPosition({
        vault: v.address, bot: "launch", token,
        spentPls: L.perLaunchPls, tokensOut: res.amountOut,
        tpPct: L.takeProfitPct, slPct: L.stopLossPct, trailPct: L.trailingStopPct,
        timeExitMin: L.timeExitMin,
      });
      log("info", "launch", `Opened ${L.perLaunchPls} PLS in ${token} for ${v.address}`);
    } else {
      log("warn", "launch", `${v.address} skipped ${token}: ${res.reason}`);
    }
  });
}

// eth_getLogs range per request. Public PulseChain RPCs vary in what they
// allow; 1000 has headroom on the main public endpoint. Smaller values are
// for providers that cap the range (Alchemy's free tier allows only 10).
const LOG_CHUNK_BLOCKS = Math.max(1, Number(process.env.LOG_CHUNK_BLOCKS || "1000"));

export async function scan(): Promise<void> {
  // Piggybacks on this loop's cadence rather than needing its own timer.
  await retryPendingTokens();
  const head = await provider.getBlockNumber();
  const last = Number(meta.get("last_pair_block", String(head - 200)));
  if (head <= last) return;

  const from = Math.max(last + 1, head - 4000); // cap catch-up per pass
  const f = new Contract(CFG.factory, FACTORY_ABI, provider) as Dyn;
  const filter = f.filters.PairCreated;
  if (!filter) {
    log("error", "launch", "PairCreated filter unavailable on factory ABI");
    return;
  }

  let totalNew = 0;
  let chunkStart = from;
  while (chunkStart <= head) {
    const chunkEnd = Math.min(chunkStart + LOG_CHUNK_BLOCKS - 1, head);
    try {
      const logs = await f.queryFilter(filter(), chunkStart, chunkEnd);
      for (const ev of logs) {
        const a = (ev as any).args;
        if (!a) continue;
        const [t0, t1, pair] = [a[0] as string, a[1] as string, a[2] as string];
        const token = t0.toLowerCase() === CFG.wpls.toLowerCase() ? t1
                    : t1.toLowerCase() === CFG.wpls.toLowerCase() ? t0
                    : null;
        if (!token) continue; // only PLS-quoted pairs are snipeable
        await handleNewPair(token, pair, ev.transactionHash);
      }
      totalNew += logs.length;
      // Checkpoint after every successful chunk, not just at the end - a
      // failure partway through a big catch-up shouldn't lose the progress
      // already made, or every retry re-scans from the very start again.
      meta.set("last_pair_block", String(chunkEnd));
      chunkStart = chunkEnd + 1;
    } catch (e) {
      log("error", "launch", `Scan ${chunkStart}-${chunkEnd} failed: ${(e as Error).message}`);
      return;
    }
  }
  if (totalNew) log("debug", "launch", `Scanned ${from}-${head}, ${totalNew} new pairs`);
}

export { formatEther };
