import { Contract, formatEther, parseEther } from "ethers";
import { CFG } from "./config.js";
import { provider, factory, type Dyn } from "./chain.js";
import { FACTORY_ABI, ERC20_ABI, V3_FACTORY_ABI } from "./abis.js";
import { registry, type VaultRecord } from "./registry.js";
import { screen, screenV3, recordScreen, type Screen, type ScreenLimits } from "./screener.js";
import { executeSwap, executeSwapMultiVenue } from "./executor.js";
import { findBestVenue, type Venue } from "./venues.js";
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

/** Every candidate vault's own launch settings folded into one strict-enough
 * shared screen, plus a representative trade size for venue selection. One
 * simulation covers every subscriber, not N. */
function strictestOf(candidates: VaultRecord[]): ScreenLimits & { representativeTradeEth: number } {
  return {
    maxBuyTaxBps: Math.max(...candidates.map((c) => c.launch.maxBuyTaxBps)),
    maxSellTaxBps: Math.max(...candidates.map((c) => c.launch.maxSellTaxBps)),
    requireLpLock: candidates.every((c) => c.launch.requireLpLock),
    maxDeployerPct: Math.max(...candidates.map((c) => c.launch.maxDeployerPct)),
    minLiquidityPls: Math.min(...candidates.map((c) => c.launch.minLiquidityPls)),
    // The trade most likely to reveal a venue that can't actually absorb the
    // size someone wants to buy - screening against the biggest ask is the
    // conservative choice, not the average.
    representativeTradeEth: Math.max(...candidates.map((c) => c.launch.perLaunchPls)),
  };
}

async function handleNewToken(token: string, txHash: string, discoveryBlock: number): Promise<void> {
  if (seen.has(token.toLowerCase())) return;
  seen.add(token.toLowerCase());

  const candidates = registry.active().filter((v) => v.launch.enabled && v.launch.perLaunchPls > 0);
  if (candidates.length === 0) return;

  const deployer = await deployerOf(txHash);
  const { representativeTradeEth, ...limits } = strictestOf(candidates);

  // Checks every venue that currently exists for this token (V2 and, if
  // configured, every V3 fee tier) and picks whichever prices best at the
  // size someone actually wants to trade - see venues.ts for why that beats
  // comparing raw liquidity numbers across fundamentally different AMM models.
  const venue = await findBestVenue(token, representativeTradeEth);
  if (!venue) return; // no real pool anywhere for this token yet

  log("info", "launch", `New token ${token}, best venue: ${venue.kind}${venue.kind === "v3" ? ` fee=${venue.fee}` : ""}`);

  const s: Screen = venue.kind === "v2"
    ? await screen(token, deployer, limits, discoveryBlock)
    : await screenV3(token, deployer, limits, venue.fee, discoveryBlock);
  recordScreen(s);

  if (!s.sellable) {
    log("info", "launch", `Rejected ${token}: ${s.reason}`);
    return;
  }
  log("info", "launch", `Screened ${token} via ${venue.kind}: buyTax ${s.buyTaxBps}bps sellTax ${s.sellTaxBps}bps ` +
    `lp ${s.lpLockedPct.toFixed(0)}% deployer ${s.deployerPct.toFixed(0)}% liq ${Math.round(s.liqPls)} ETH`);

  await ensureWatched(token);

  // Each candidate vault gets exactly one buy-or-skip decision here, and
  // vaults are independent, so this runs concurrently (bounded by
  // KEEPER_CONCURRENCY) rather than one vault at a time - a hot launch with
  // many subscribers should not queue up behind a slow RPC round trip per vault.
  await mapLimit(candidates, CFG.keeperConcurrency, async (v) => {
    const L = v.launch;
    // A plain V2-only vault (BotVault) has no way to execute a V3 trade -
    // it simply doesn't have that function on chain. Skip, don't error.
    if (venue.kind === "v3" && v.kind !== "multiVenue") return;
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
    // New pairs move violently in the first blocks. Tighter than the default
    // means more skipped fills and fewer terrible ones.
    const slippageBps = Math.min(CFG.maxSlippageBps, 300);

    const res = venue.kind === "v2"
      ? (v.kind === "multiVenue"
          ? await executeSwapMultiVenue({
              vault: v.address, bot: "launch", venue: { kind: "v2", path: [CFG.weth, token] },
              amountIn, tokenLabel: token, slippageBps,
            })
          : await executeSwap({
              vault: v.address, bot: "launch", path: [CFG.weth, token],
              amountIn, tokenLabel: token, slippageBps,
            }))
      : await executeSwapMultiVenue({
          vault: v.address, bot: "launch",
          venue: { kind: "v3", tokenIn: CFG.weth, tokenOut: token, fee: venue.fee },
          amountIn, tokenLabel: token, slippageBps,
        });

    if (res.ok) {
      openPosition({
        vault: v.address, bot: "launch", token,
        spentPls: L.perLaunchPls, tokensOut: res.amountOut,
        tpPct: L.takeProfitPct, slPct: L.stopLossPct, timeExitMin: L.timeExitMin,
      });
      log("info", "launch", `Opened ${L.perLaunchPls} ETH in ${token} for ${v.address} via ${venue.kind}`);
    } else {
      log("warn", "launch", `${v.address} skipped ${token}: ${res.reason}`);
    }
  });
}

// Alchemy's free tier caps eth_getLogs to a 10-block range per request - a
// paid plan raises this, but until then the scanner has to walk the chain in
// small windows instead of one big range, or every single scan fails.
const LOG_CHUNK_BLOCKS = 10;

/**
 * Shared chunked-scan walk, used by both the V2 and V3 watchers below. Each
 * keeps its own checkpoint (`checkpointKey`) so one falling behind (or one
 * not configured at all) never affects the other.
 */
async function scanFactory(
  factoryAddr: string,
  factoryAbi: string[],
  checkpointKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getFilter: (f: Dyn) => any,
  onEvent: (ev: { args?: unknown; transactionHash: string; blockNumber: number }) => Promise<void>,
): Promise<void> {
  const head = await provider.getBlockNumber();
  const last = Number(meta.get(checkpointKey, String(head - 200)));
  if (head <= last) return;

  const from = Math.max(last + 1, head - 4000); // cap catch-up per pass
  const f = new Contract(factoryAddr, factoryAbi, provider) as Dyn;

  let totalNew = 0;
  let chunkStart = from;
  while (chunkStart <= head) {
    const chunkEnd = Math.min(chunkStart + LOG_CHUNK_BLOCKS - 1, head);
    try {
      const logs = await f.queryFilter(getFilter(f), chunkStart, chunkEnd);
      for (const ev of logs) await onEvent(ev as { args?: unknown; transactionHash: string; blockNumber: number });
      totalNew += logs.length;
      // Checkpoint after every successful chunk, not just at the end - a
      // failure partway through a big catch-up shouldn't lose the progress
      // already made, or every retry re-scans from the very start again.
      meta.set(checkpointKey, String(chunkEnd));
      chunkStart = chunkEnd + 1;
    } catch (e) {
      log("error", "launch", `Scan ${chunkStart}-${chunkEnd} (${checkpointKey}) failed: ${(e as Error).message}`);
      return;
    }
  }
  if (totalNew) log("debug", "launch", `Scanned ${checkpointKey} ${from}-${head}, ${totalNew} new`);
}

/** V2 PairCreated - each pair is exactly one token/WETH combination. */
export async function scan(): Promise<void> {
  await scanFactory(CFG.factory, FACTORY_ABI, "last_pair_block", (f) => f.filters.PairCreated!(), async (ev) => {
    const a = ev.args as [string, string, string, bigint] | undefined;
    if (!a) return;
    const [t0, t1] = a;
    const token = t0.toLowerCase() === CFG.weth.toLowerCase() ? t1
                : t1.toLowerCase() === CFG.weth.toLowerCase() ? t0
                : null;
    if (!token) return; // only WETH-quoted pairs are snipeable
    await handleNewToken(token, ev.transactionHash, ev.blockNumber);
  });
}

/**
 * V3 PoolCreated - unlike V2, a token can have several of these (one per fee
 * tier). handleNewToken() dedupes by TOKEN, not by pool, and findBestVenue()
 * re-checks every venue that exists by the time it runs, so this doesn't
 * need to track which specific fee tier triggered it - noticing the token
 * exists is all this scanner's job is.
 */
export async function scanV3(): Promise<void> {
  if (!CFG.factoryV3) return; // not configured - V3 scanning simply disabled
  await scanFactory(CFG.factoryV3, V3_FACTORY_ABI, "last_pool_block_v3", (f) => f.filters.PoolCreated!(), async (ev) => {
    const a = ev.args as [string, string, number, number, string] | undefined;
    if (!a) return;
    const [t0, t1] = a;
    const token = t0.toLowerCase() === CFG.weth.toLowerCase() ? t1
                : t1.toLowerCase() === CFG.weth.toLowerCase() ? t0
                : null;
    if (!token) return;
    await handleNewToken(token, ev.transactionHash, ev.blockNumber);
  });
}

export { formatEther };
