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

/** WETH the vault currently holds, in whole PLS. */
async function vaultWethBalance(vault: string): Promise<number> {
  const weth = new Contract(CFG.weth, ERC20_ABI, provider) as Dyn;
  return Number(formatEther(await weth.balanceOf(vault)));
}

/**
 * Watches PulseX for new pairs and hands each one to the screener.
 *
 * Scans by block range rather than a live subscription. Public Robinhood Chain RPCs
 * drop websocket connections regularly, and a missed PairCreated event is a
 * missed launch with no way to notice. Polling ranges is slower by a few
 * seconds and never silently loses anything.
 */

const seen = new Set<string>();

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

async function handleNewPair(token: string, pair: string, txHash: string, blockNumber: number): Promise<void> {
  if (seen.has(token.toLowerCase())) return;
  seen.add(token.toLowerCase());

  const candidates = registry.active().filter((v) => v.launch.enabled && v.launch.perLaunchPls > 0);
  if (candidates.length === 0) return;

  log("info", "launch", `New pair ${pair} for token ${token}`);
  const deployer = await deployerOf(txHash);

  // Screen once with the strictest limits any subscriber uses, then let each
  // vault apply its own thresholds to the result. One simulation, not N.
  const strictest = {
    maxBuyTaxBps: Math.max(...candidates.map((c) => c.launch.maxBuyTaxBps)),
    maxSellTaxBps: Math.max(...candidates.map((c) => c.launch.maxSellTaxBps)),
    requireLpLock: candidates.every((c) => c.launch.requireLpLock),
    maxDeployerPct: Math.max(...candidates.map((c) => c.launch.maxDeployerPct)),
    minLiquidityPls: Math.min(...candidates.map((c) => c.launch.minLiquidityPls)),
  };

  const s = await screen(token, deployer, strictest, blockNumber);
  recordScreen(s);

  if (!s.sellable) {
    log("info", "launch", `Rejected ${token}: ${s.reason}`);
    return;
  }
  log("info", "launch", `Screened ${token}: buyTax ${s.buyTaxBps}bps sellTax ${s.sellTaxBps}bps ` +
    `lp ${s.lpLockedPct.toFixed(0)}% deployer ${s.deployerPct.toFixed(0)}% liq ${Math.round(s.liqPls)} ETH`);

  await ensureWatched(token);

  // Each candidate vault gets exactly one buy-or-skip decision here, and
  // vaults are independent, so this runs concurrently (bounded by
  // KEEPER_CONCURRENCY) rather than one vault at a time - a hot launch with
  // many subscribers should not queue up behind a slow RPC round trip per vault.
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const L = v.launch;
    if (firesToday(v.address) >= L.maxPerDay) return;
    if (s.buyTaxBps > L.maxBuyTaxBps) return;
    if (s.sellTaxBps > L.maxSellTaxBps) return;
    if (L.requireLpLock && s.lpLockedPct < 95) return;
    if (s.deployerPct > L.maxDeployerPct) return;
    if (s.liqPls < L.minLiquidityPls) return;

    // Holding cap, same guard the rule bot uses. A fresh launch token has no
    // position yet, so its current value is whatever the vault already bought.
    const { total: posValue, byToken } = await positionsValuePls(v.address);
    const totalValue = (await vaultWethBalance(v.address)) + posValue;
    const tokenNow = byToken.get(token.toLowerCase()) ?? 0;
    if (exceedsHoldingCap(tokenNow + L.perLaunchPls, totalValue, v.maxHoldingPct)) {
      log("info", "launch", `${v.address} ${token}: holding cap ${v.maxHoldingPct}% would be exceeded, skipping`);
      return;
    }

    const amountIn = parseEther(String(L.perLaunchPls));
    const res = await executeSwap({
      vault: v.address, bot: "launch", path: [CFG.weth, token],
      amountIn, tokenLabel: token,
      // New pairs move violently in the first blocks. Tighter than the default
      // means more skipped fills and fewer terrible ones.
      slippageBps: Math.min(CFG.maxSlippageBps, 300),
    });

    if (res.ok) {
      openPosition({
        vault: v.address, bot: "launch", token,
        spentPls: L.perLaunchPls, tokensOut: res.amountOut,
        tpPct: L.takeProfitPct, slPct: L.stopLossPct, timeExitMin: L.timeExitMin,
      });
      log("info", "launch", `Opened ${L.perLaunchPls} ETH in ${token} for ${v.address}`);
    } else {
      log("warn", "launch", `${v.address} skipped ${token}: ${res.reason}`);
    }
  });
}

// Alchemy's free tier caps eth_getLogs to a 10-block range per request - a
// paid plan raises this, but until then the scanner has to walk the chain in
// small windows instead of one big range, or every single scan fails.
const LOG_CHUNK_BLOCKS = 10;

export async function scan(): Promise<void> {
  const head = await provider.getBlockNumber();
  const last = Number(meta.get("last_pair_block", String(head - 200)));
  if (head <= last) return;

  const from = Math.max(last + 1, head - 4000); // cap catch-up per pass
  const f = new Contract(CFG.factory, FACTORY_ABI, provider) as Dyn;
  const filter = f.filters.PairCreated;
  if (!filter) { log("error", "launch", "PairCreated filter unavailable on factory ABI"); return; }

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
        const token = t0.toLowerCase() === CFG.weth.toLowerCase() ? t1
                    : t1.toLowerCase() === CFG.weth.toLowerCase() ? t0
                    : null;
        if (!token) continue; // only WETH-quoted pairs are snipeable
        await handleNewPair(token, pair, ev.transactionHash, ev.blockNumber);
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
