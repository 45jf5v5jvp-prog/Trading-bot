import { parseEther } from "ethers";
import { CFG } from "./config.js";
import { registry, type TargetSnipe, type VaultRecord } from "./registry.js";
import { simulate, simulateV3, simulateV4 } from "./screener.js";
import { findBestVenue, type Venue } from "./venues.js";
import { executeSwap, executeSwapMultiVenue, type TradeVenue } from "./executor.js";
import { openPosition } from "./positions.js";
import { ensureWatched } from "./prices.js";
import { db } from "./db.js";
import { log } from "./log.js";

/**
 * Buys one specific, user-chosen contract address the moment it becomes
 * tradeable on ANY venue (V2, V3, or V4), instead of waiting for the Launch
 * Bot to discover it on its own. For a token spotted before its pool
 * exists - a presale everyone is watching, a tip in a group chat - "wait
 * for the scanner to notice it like every other token" throws away the
 * head start that made it worth watching in the first place.
 *
 * Deliberately NOT the same screening path as launch.ts/screenV3/screenV4.
 * The age check, deployer-share cap, liquidity floor, and LP-lock/hook
 * allowlist requirement all exist to judge a token this bot has never seen
 * before; none of that applies when a human already decided to buy this
 * exact address. What still runs is the honeypot/sellability simulation -
 * the one check that protects against a fat-fingered or malicious address
 * regardless of how deliberately it was chosen.
 */

function alreadyFired(vault: string, token: string): boolean {
  const r = db.prepare(`SELECT 1 FROM fires WHERE vault=? AND bot='snipe' AND token=? LIMIT 1`)
    .get(vault.toLowerCase(), token.toLowerCase());
  return Boolean(r);
}

async function sellableViaVenue(token: string, venue: Venue): Promise<{ sellable: boolean; roundTripLossBps: number } | null> {
  if (venue.kind === "v2") return simulate(token);
  if (venue.kind === "v3") return simulateV3(token, venue.fee);
  return simulateV4(venue.key);
}

async function fireSnipe(v: VaultRecord, s: TargetSnipe): Promise<void> {
  const token = s.token.toLowerCase();
  const amountIn = parseEther(String(s.amountPls));

  const venue = await findBestVenue(token, s.amountPls);
  if (!venue) return; // not tradeable yet, try again next tick

  // A plain V2-only vault (BotVault) has no way to execute a V3/V4 trade -
  // wait for a V2 venue to exist for it, don't error.
  if (venue.kind === "v3" && v.kind !== "multiVenue" && v.kind !== "multiVenueV4") return;
  if (venue.kind === "v4" && v.kind !== "multiVenueV4") return;

  const sim = await sellableViaVenue(token, venue);
  if (!sim) {
    log("warn", "snipe", `${v.address} target ${token}: simulation unavailable, refusing to guess`);
    return;
  }
  if (!sim.sellable) {
    log("warn", "snipe", `${v.address} target ${token}: cannot sell after buying, skipped - this looks like a honeypot`);
    return;
  }
  if (sim.roundTripLossBps > CFG.honeypotMaxLossBps) {
    log("warn", "snipe", `${v.address} target ${token}: round trip loses ${sim.roundTripLossBps} bps, skipped`);
    return;
  }

  await ensureWatched(token);

  const buyVenue: TradeVenue = venue.kind === "v2"
    ? { kind: "v2", path: [CFG.weth, token] }
    : venue.kind === "v3"
    ? { kind: "v3", tokenIn: CFG.weth, tokenOut: token, fee: venue.fee }
    : { kind: "v4", key: venue.key, buy: true };

  // New pairs move violently in the first blocks - same tighter-than-default
  // slippage the launch bot uses for exactly the same reason.
  const slippageBps = Math.min(CFG.maxSlippageBps, 300);

  const res = venue.kind === "v2" && v.kind === "v2"
    ? await executeSwap({ vault: v.address, bot: "snipe", path: [CFG.weth, token], amountIn, tokenLabel: token, slippageBps })
    : await executeSwapMultiVenue({ vault: v.address, bot: "snipe", venue: buyVenue, amountIn, tokenLabel: token, slippageBps });

  if (res.ok) {
    openPosition({
      vault: v.address, bot: "snipe", token,
      spentPls: s.amountPls, tokensOut: res.amountOut,
      tpPct: s.tpPct, slPct: s.slPct, trailPct: s.trailingStopPct, timeExitMin: s.timeExitMin,
    });
    log("info", "snipe", `${v.address} sniped ${s.amountPls} ETH of ${token} via ${venue.kind}`);
  } else {
    log("warn", "snipe", `${v.address} target ${token} not filled: ${res.reason}`);
  }
}

export async function tick(): Promise<void> {
  for (const v of registry.active()) {
    for (const s of v.snipes) {
      if (alreadyFired(v.address, s.token)) continue;
      try {
        await fireSnipe(v, s);
      } catch (e) {
        log("error", "snipe", `${v.address} target ${s.token}: ${(e as Error).message}`);
      }
    }
  }
}
