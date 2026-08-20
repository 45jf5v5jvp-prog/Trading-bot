import { parseEther } from "ethers";
import { CFG } from "./config.js";
import { registry } from "./registry.js";
import { askBuyFires } from "./db.js";
import { ensureWatched } from "./prices.js";
import { findBestVenue } from "./venues.js";
import { executeSwap, executeSwapMultiVenue, type TradeVenue } from "./executor.js";
import { openPosition } from "./positions.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";

/**
 * Executes "Buy it" requests from Ask Icaria (the site's on-demand token
 * Q&A - see site/lib/askIcaria.js/claude.js). The site already ran the
 * mechanical honeypot/tax/LP-lock checks and, if configured, an AI read
 * before showing a buy button at all - this module's only job is to spend
 * exactly what the signed request says, once.
 *
 * Deliberately no per-vault config (amount, exits) the way Discovery/Hunter
 * have: an Ask Icaria buy is a one-off manual trade at a user-chosen
 * amount, not a recurring bot rule, so it opens with no automatic exits -
 * the position shows up in the vault like any other and the owner manages
 * it manually (or layers a Limit Order / Trading Rule on it afterward).
 *
 * Venue-aware, unlike hunter.ts/discovery.ts's V2-only detection: a user can
 * paste ANY token address, including one that only ever traded on V3 or V4
 * (see site/lib/askIcaria.js's own venue-aware profile), so this mirrors
 * snipe.ts's full findBestVenue negotiation rather than discovery.ts's
 * fixed-V2 shortcut - the one other bot here that also acts on an arbitrary,
 * not-self-discovered address.
 */

interface AskBuyRequest { id: number; token: string; amountPls: number }

async function fetchAskBuyRequests(vault: string): Promise<AskBuyRequest[]> {
  const api = process.env.CONFIG_API;
  if (!api) return [];
  try {
    const res = await fetch(`${api}/vaults/${vault}/ask-buy-requests`);
    if (!res.ok) return [];
    return (await res.json()) as AskBuyRequest[];
  } catch (e) {
    log("warn", "ask", `Buy-request fetch failed for ${vault}: ${(e as Error).message}`);
    return [];
  }
}

export async function tick(): Promise<void> {
  await mapLimit(registry.active(), CFG.keeperConcurrency, async (v) => {
    const reqs = await fetchAskBuyRequests(v.address);
    for (const r of reqs) {
      if (askBuyFires.has(v.address, r.id)) continue;
      try {
        const token = r.token.toLowerCase();
        const venue = await findBestVenue(token, r.amountPls);
        if (!venue) {
          log("warn", "ask", `${v.address} ask-buy #${r.id}: ${token} isn't tradeable on any known venue right now, will retry`);
          continue;
        }
        // A plain V2-only vault (BotVault) has no way to execute a V3/V4
        // trade - wait for a V2 venue to exist, same gating snipe.ts uses.
        if (venue.kind === "v3" && v.kind !== "multiVenue" && v.kind !== "multiVenueV4") continue;
        if (venue.kind === "v4" && v.kind !== "multiVenueV4") continue;

        const amountIn = parseEther(String(r.amountPls));
        const buyVenue: TradeVenue = venue.kind === "v2"
          ? { kind: "v2", path: [CFG.weth, token] }
          : venue.kind === "v3"
          ? { kind: "v3", tokenIn: CFG.weth, tokenOut: token, fee: venue.fee }
          : { kind: "v4", key: venue.key, buy: true };
        const slippageBps = Math.min(CFG.maxSlippageBps, 300);

        const res = venue.kind === "v2" && v.kind === "v2"
          ? await executeSwap({ vault: v.address, bot: "ask", path: [CFG.weth, token], amountIn, tokenLabel: token, slippageBps })
          : await executeSwapMultiVenue({ vault: v.address, bot: "ask", venue: buyVenue, amountIn, tokenLabel: token, slippageBps });

        if (res.ok) {
          await ensureWatched(token);
          openPosition({
            vault: v.address, bot: "ask", token,
            spentPls: r.amountPls, tokensOut: res.amountOut,
            tpPct: 0, slPct: 0, trailPct: 0, timeExitMin: 0,
          });
          askBuyFires.record(v.address, r.id, res.txHash);
          log("info", "ask", `${v.address} bought ${r.amountPls} ETH of ${token} via ${venue.kind} on ask-buy request #${r.id}`);
        } else {
          log("warn", "ask", `${v.address} ask-buy #${r.id} not filled: ${res.reason}`);
        }
      } catch (e) {
        log("error", "ask", `${v.address} ask-buy #${r.id}: ${(e as Error).message}`);
      }
    }
  });
}
