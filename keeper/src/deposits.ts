import { Contract, formatEther } from "ethers";
import { CFG } from "./config.js";
import { provider, routerRead, type Dyn } from "./chain.js";
import { ERC20_ABI } from "./abis.js";
import { registry } from "./registry.js";
import { ensureWatched } from "./prices.js";
import { openPosition } from "./positions.js";
import { mapLimit } from "./concurrency.js";
import { db } from "./db.js";
import { log } from "./log.js";
import { fetchWithTimeout } from "./httpTimeout.js";

/**
 * Turns a manually-deposited token into a tracked position, so it shows up
 * on Current Holdings the same as anything a bot bought itself - see
 * site/pages/index.js's "Deposit a Token" panel. The deposit itself is a
 * plain wallet-to-vault ERC20 transfer the owner signs directly (the vault's
 * own deposit() only accepts its allow-listed tokens, which on PulseChain is
 * WPLS alone) - the site just tells the keeper "go look for this token,"
 * signed the same way every other manual action here is (see lib/auth.js's
 * authorizeDepositNotice). This module never moves money; it only reads a
 * balance that's already sitting in the vault and records it.
 */

interface DepositNotice { id: number; token: string }

async function fetchDepositNotices(vault: string): Promise<DepositNotice[]> {
  const api = process.env.CONFIG_API;
  if (!api) return [];
  try {
    const res = await fetchWithTimeout(`${api}/vaults/${vault}/deposit-notices`);
    if (!res.ok) return [];
    return (await res.json()) as DepositNotice[];
  } catch (e) {
    log("warn", "deposits", `Deposit-notice fetch failed for ${vault}: ${(e as Error).message}`);
    return [];
  }
}

/** A second notice for a token already being tracked (a top-up deposit, or
 * just a duplicate submission) has nothing new to do - the existing open
 * position is the one record for it, same "look once" shape as everything
 * else that dedups against the positions table directly instead of a
 * separate marker table. */
function alreadyTracked(vault: string, token: string): boolean {
  const r = db.prepare(`SELECT 1 FROM positions WHERE vault=? AND token=? AND bot='deposit' AND status='open'`)
    .get(vault.toLowerCase(), token.toLowerCase());
  return Boolean(r);
}

export async function tick(): Promise<void> {
  await mapLimit(registry.active(), CFG.keeperConcurrency, async (v) => {
    const notices = await fetchDepositNotices(v.address);
    for (const n of notices) {
      if (alreadyTracked(v.address, n.token)) continue;
      try {
        const erc = new Contract(n.token, ERC20_ABI, provider) as Dyn;
        const bal: bigint = await erc.balanceOf(v.address);
        // The transfer may not have landed on chain yet, or the owner typed
        // the wrong address - either way there's nothing to track yet.
        // pendingDepositNotices on the site side stops returning this after
        // 24h, so this isn't checked forever.
        if (bal <= 0n) continue;

        await ensureWatched(n.token);

        // A quote can fail outright for a token with no real pair yet (a
        // scam, or one nobody's listed anywhere) - that is exactly the case
        // this still needs to track rather than skip, so the owner has a
        // Withdraw to Wallet button to fall back on instead of a token that
        // silently never shows up anywhere. 0 here just means no P&L
        // percentage to show, same treatment as any other unpriceable
        // position elsewhere on the dashboard.
        let spentPls = 0;
        try {
          const amounts: bigint[] = await routerRead.getAmountsOut(bal, [n.token, CFG.wpls]);
          spentPls = Number(formatEther(amounts[amounts.length - 1]!));
        } catch { /* leave spentPls at 0 */ }

        openPosition({
          vault: v.address, bot: "deposit", token: n.token,
          spentPls, tokensOut: bal,
          // No automatic exits - same treatment ask.ts gives a manual buy.
          // The owner manages this themselves: Close Position, Withdraw to
          // Wallet, or layer a Limit Order on top.
          tpPct: 0, slPct: 0, trailPct: 0, timeExitMin: 0,
        });
        log("info", "deposits", `${v.address} started tracking a manually deposited token ${n.token} (${bal.toString()} raw units, ~${spentPls.toFixed(0)} PLS)`);
      } catch (e) {
        log("warn", "deposits", `${v.address} deposit-notice #${n.id} for ${n.token}: ${(e as Error).message}`);
      }
    }
  });
}
