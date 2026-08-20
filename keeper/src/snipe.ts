import { parseEther } from "ethers";
import { CFG } from "./config.js";
import { routerRead, factory } from "./chain.js";
import { registry, type TargetSnipe, type VaultRecord } from "./registry.js";
import { simulate } from "./screener.js";
import { executeSwap } from "./executor.js";
import { openPosition } from "./positions.js";
import { ensureWatched } from "./prices.js";
import { db } from "./db.js";
import { log } from "./log.js";

/**
 * Buys one specific, user-chosen contract address the moment it becomes
 * tradeable, instead of waiting for the Launch Bot to discover it on its
 * own. For a token spotted before its pool exists - a presale everyone is
 * watching, a tip in a group chat - "wait for PairCreated like every other
 * token" throws away the head start that made it worth watching in the
 * first place.
 *
 * Deliberately NOT the same screening path as launch.ts. The age check,
 * deployer-share cap, liquidity floor, and LP-lock requirement all exist to
 * judge a token this bot has never seen before; none of that applies when a
 * human already decided to buy this exact address. What still runs is the
 * honeypot/sellability simulation - the one check that protects against a
 * fat-fingered or malicious address regardless of how deliberately it was
 * chosen.
 */

/** Already bought this token for this vault via a snipe, ever - a snipe
 * fires once per configured target, not repeatedly every tick. */
function alreadyFired(vault: string, token: string): boolean {
  const r = db.prepare(`SELECT 1 FROM fires WHERE vault=? AND bot='snipe' AND token=? LIMIT 1`)
    .get(vault.toLowerCase(), token.toLowerCase());
  return Boolean(r);
}

async function isTradeable(token: string, amountIn: bigint): Promise<boolean> {
  try {
    const pair: string = await factory.getPair(token, CFG.wpls);
    if (/^0x0{40}$/i.test(pair)) return false;
    const amounts: bigint[] = await routerRead.getAmountsOut(amountIn, [CFG.wpls, token]);
    return (amounts[amounts.length - 1] ?? 0n) > 0n;
  } catch {
    return false;
  }
}

async function fireSnipe(v: VaultRecord, s: TargetSnipe): Promise<void> {
  const token = s.token.toLowerCase();
  const amountIn = parseEther(String(s.amountPls));

  if (!(await isTradeable(token, amountIn))) return; // not live yet, try again next tick

  const sim = await simulate(token);
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

  const res = await executeSwap({
    vault: v.address, bot: "snipe", path: [CFG.wpls, token],
    amountIn, tokenLabel: token,
    // Same reasoning as the launch bot: a target snipe is racing other
    // buyers into a token that may move violently in its first blocks.
    slippageBps: Math.min(CFG.maxSlippageBps, 300),
  });

  if (res.ok) {
    openPosition({
      vault: v.address, bot: "snipe", token,
      spentPls: s.amountPls, tokensOut: res.amountOut,
      tpPct: s.tpPct, slPct: s.slPct, trailPct: s.trailingStopPct, timeExitMin: s.timeExitMin,
    });
    log("info", "snipe", `${v.address} sniped ${s.amountPls} PLS of ${token}`);
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
