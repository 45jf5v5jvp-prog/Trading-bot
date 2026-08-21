import { CFG } from "./config.js";
import { verifyChain, keeper, provider, txQueue } from "./chain.js";
import { refresh, registry } from "./registry.js";
import { pollAll } from "./prices.js";
import * as rules from "./rules.js";
import * as launch from "./launch.js";
import * as snipe from "./snipe.js";
import * as limits from "./limits.js";
import * as discovery from "./discovery.js";
import * as hunter from "./hunter.js";
import * as marketSeed from "./marketSeed.js";
import * as ask from "./ask.js";
import * as positions from "./positions.js";
import { db } from "./db.js";
import { log } from "./log.js";

let stopping = false;
process.on("SIGINT", () => { log("warn", "main", "Shutting down after current pass"); stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
process.on("unhandledRejection", (e) => log("error", "main", `Unhandled rejection: ${e}`));

/** Runs fn every `sec` seconds, never overlapping itself. */
function loop(name: string, sec: number, fn: () => Promise<void>): void {
  let running = false;
  const run = async () => {
    if (stopping || running) return;
    running = true;
    const t0 = Date.now();
    try { await fn(); }
    catch (e) { log("error", name, (e as Error).message); }
    finally {
      running = false;
      const ms = Date.now() - t0;
      if (ms > sec * 1000) log("warn", name, `Pass took ${(ms / 1000).toFixed(1)}s, longer than its ${sec}s interval`);
    }
  };
  void run();
  setInterval(run, sec * 1000);
}

async function main(): Promise<void> {
  log("info", "main", "Icaria keeper starting");

  if (!keeper) {
    log("error", "main", "No KEEPER_PRIVATE_KEY. Set one, or the keeper can only observe.");
  } else {
    process.env.KEEPER_ADDRESS = keeper.address;
    const bal = await provider.getBalance(keeper.address);
    log("info", "main", `Keeper ${keeper.address}, ${Number(bal) / 1e18} PLS for gas`);
    if (bal === 0n) log("error", "main", "Keeper has no PLS. Every transaction will fail.");
  }

  await verifyChain();

  if (CFG.vaultFactory === "0x0000000000000000000000000000000000000000")
    log("error", "main", "VAULT_FACTORY is unset. No vaults will be found.");
  if (!process.env.PROBE_ADDRESS)
    log("error", "main", "PROBE_ADDRESS is unset. Launch Bot will refuse every token rather than buy unscreened.");
  if (CFG.dryRun)
    log("warn", "main", "DRY_RUN is on. Everything is evaluated and simulated, nothing is broadcast.");
  if (CFG.globalKill)
    log("warn", "main", "GLOBAL_KILL is on. No swaps will execute.");

  await refresh();

  loop("registry", CFG.registryRefreshSec, async () => { await refresh(); });
  loop("prices", CFG.pricePollSec, pollAll);
  loop("launch", CFG.pairScanSec, launch.scan);
  // Fires immediately on startup, then re-walks the whole PulseX pair list
  // every marketSeedRefreshHours - see marketSeed.ts. This is what lets
  // Hunter/Discovery Bot see established tokens (HEX, INC, PLSX, ...), not
  // just fresh launches, without slowing down anything else in this loop.
  loop("marketSeed", CFG.marketSeedRefreshHours * 3600, marketSeed.seedMarket);
  // Same cadence as the launch scanner - a target snipe is racing other
  // buyers into a token the moment its pool exists, so it checks on every
  // pass rather than a slower dedicated interval.
  loop("snipe", CFG.pairScanSec, snipe.tick);
  // Not racing anyone - a resting order fires whenever the price is right,
  // so the position-check cadence (already "how are my holdings doing?")
  // fits better than the launch scanner's fast pace.
  loop("limits", CFG.positionCheckSec, limits.tick);
  loop("discovery", CFG.discoveryScanSec, discovery.tick);
  loop("hunter", CFG.hunterScanSec, hunter.tick);
  // A user waiting on their own "Buy it" click deserves a fast poll, same
  // urgency as snipe/limit orders.
  loop("ask", CFG.positionCheckSec, ask.tick);
  loop("rules", CFG.ruleEvalSec, rules.tick);
  loop("positions", CFG.positionCheckSec, positions.tick);

  loop("health", 300, async () => {
    const open = (db.prepare("SELECT COUNT(*) n FROM positions WHERE status='open'").get() as { n: number }).n;
    const stuck = (db.prepare("SELECT COUNT(*) n FROM positions WHERE status='stuck'").get() as { n: number }).n;
    const fires = (db.prepare("SELECT COUNT(*) n FROM fires WHERE ts>=?")
      .get(Math.floor(Date.now() / 1000) - 86400) as { n: number }).n;
    log("info", "health", `vaults=${registry.active().length} open=${open} stuck=${stuck} fires24h=${fires} queue=${txQueue.pending}`);
  });

  log("info", "main", "All loops running");
}

main().catch((e) => { log("error", "main", `Fatal: ${(e as Error).message}`); process.exit(1); });
