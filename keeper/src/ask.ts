import { parseEther } from "ethers";
import { CFG } from "./config.js";
import { registry } from "./registry.js";
import { askBuyFires } from "./db.js";
import { ensureWatched } from "./prices.js";
import { executeSwap } from "./executor.js";
import { openPosition } from "./positions.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";
import { fetchWithTimeout } from "./httpTimeout.js";

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
 */

interface AskBuyRequest { id: number; token: string; amountPls: number }

async function fetchAskBuyRequests(vault: string): Promise<AskBuyRequest[]> {
  const api = process.env.CONFIG_API;
  if (!api) return [];
  try {
    const res = await fetchWithTimeout(`${api}/vaults/${vault}/ask-buy-requests`);
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
        const amountIn = parseEther(String(r.amountPls));
        const res = await executeSwap({
          vault: v.address, bot: "ask", path: [CFG.wpls, r.token], amountIn, tokenLabel: r.token,
          slippageBps: Math.min(CFG.maxSlippageBps, 300),
        });
        if (res.ok) {
          await ensureWatched(r.token);
          openPosition({
            vault: v.address, bot: "ask", token: r.token,
            spentPls: r.amountPls, tokensOut: res.amountOut,
            tpPct: 0, slPct: 0, trailPct: 0, timeExitMin: 0,
          });
          askBuyFires.record(v.address, r.id, res.txHash);
          log("info", "ask", `${v.address} bought ${r.amountPls} PLS of ${r.token} on ask-buy request #${r.id}`);
        } else {
          log("warn", "ask", `${v.address} ask-buy #${r.id} not filled: ${res.reason}`);
        }
      } catch (e) {
        log("error", "ask", `${v.address} ask-buy #${r.id}: ${(e as Error).message}`);
      }
    }
  });
}
