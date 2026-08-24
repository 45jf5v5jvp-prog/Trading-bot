#!/usr/bin/env node
/**
 * Per-vault Hunter Bot diagnostic: what each vault's Hunter settings
 * actually are, next to what Hunter has actually done for that vault -
 * so "why isn't Hunter trading for other vaults" is answered with real
 * numbers instead of a guess. Two separate databases, read-only, no key
 * needed:
 *   - site.db (site/lib/store.js's vault_configs) - each vault's SAVED
 *     Hunter settings, the same ones shown on their dashboard.
 *   - keeper.db (keeper/src/db.ts's fires/positions) - what Hunter has
 *     actually bought/sold for that vault.
 *
 * A vault sitting quiet isn't necessarily broken - a strict minLiquidityPls,
 * a high minAiConfidence, requireAiApproval with a model that rarely
 * clears the bar, or a small maxOpenPositions can all legitimately mean
 * "correctly waiting," especially right after v3.36.0/v3.40.0 started
 * actually enforcing each vault's OWN thresholds instead of the loosest
 * one across all subscribers - a vault with tighter settings than others
 * may look like it slowed down because it's now buying LESS incorrectly,
 * not less than it should. This script exists to tell the two apart.
 *
 * Usage: node scripts/hunter-activity.js
 * (Override SITE_DB_PATH or DB_PATH env vars to match a non-default setup -
 * same variables the site/keeper themselves read.)
 */
const path = require("path");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  // No package.json/node_modules of its own - same fallback vault-count.js/
  // seed-progress.js use, borrowing the keeper's, guaranteed to exist
  // wherever the keeper itself is actually running.
  Database = require(path.join(__dirname, "..", "keeper", "node_modules", "better-sqlite3"));
}

const SITE_DB_PATH = process.env.SITE_DB_PATH || path.join(__dirname, "..", "site", "site.db");
const KEEPER_DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "keeper", "keeper.db");

function short(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function main() {
  const siteDb = new Database(SITE_DB_PATH, { readonly: true, fileMustExist: true });
  const keeperDb = new Database(KEEPER_DB_PATH, { readonly: true, fileMustExist: true });

  const configRows = siteDb.prepare("SELECT vault, config FROM vault_configs").all();
  const vaultsFromKeeper = keeperDb.prepare(
    "SELECT DISTINCT vault FROM positions WHERE bot='hunter' UNION SELECT DISTINCT vault FROM fires WHERE bot='hunter'",
  ).all().map((r) => r.vault);

  const vaults = new Set([...configRows.map((r) => r.vault), ...vaultsFromKeeper]);
  if (vaults.size === 0) {
    console.log("No vaults found in either database.");
    return;
  }

  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

  // Counted from positions (opened_at/closed_at), not fires.side - side was
  // only added this session (v3.39.1) and is null on every fire from
  // before that, which would silently undercount anything but the newest
  // activity. opened_at/closed_at have always been there.
  const buysStmt = keeperDb.prepare(
    "SELECT COUNT(*) n FROM positions WHERE vault=? AND bot='hunter' AND opened_at>=?",
  );
  const sellsStmt = keeperDb.prepare(
    "SELECT COUNT(*) n FROM positions WHERE vault=? AND bot='hunter' AND status='closed' AND closed_at>=?",
  );
  const openStmt = keeperDb.prepare(
    "SELECT COUNT(*) n FROM positions WHERE vault=? AND bot='hunter' AND status='open'",
  );
  const lastFireStmt = keeperDb.prepare(
    "SELECT MAX(ts) t FROM fires WHERE vault=? AND bot='hunter'",
  );

  for (const vault of [...vaults].sort()) {
    const row = configRows.find((r) => r.vault === vault);
    const H = row ? (JSON.parse(row.config).hunter || {}) : null;

    console.log(`\n${short(vault)} (${vault})`);
    if (!H) {
      console.log("  No saved config found in site.db - never configured from the dashboard.");
    } else if (!H.enabled) {
      console.log("  Hunter Bot is OFF for this vault.");
    } else {
      console.log(`  mode=${H.mode} exitMode=${H.exitMode} requireAiApproval=${H.requireAiApproval} minAiConfidence=${H.minAiConfidence}`);
      console.log(`  minLiquidityPls=${H.minLiquidityPls?.toLocaleString?.() ?? H.minLiquidityPls} minTrades24h=${H.minTrades24h}`);
      console.log(`  requireRsi=${H.requireRsi} rsiOversold=${H.rsiOversold} requireMacdCross=${H.requireMacdCross} requireBollinger=${H.requireBollinger} bollingerPercentBMax=${H.bollingerPercentBMax}`);
      console.log(`  requireVolumeConfirmation=${H.requireVolumeConfirmation} minVolumeRatio=${H.minVolumeRatio}`);
      const alloc = H.allocatedUnlimited ? "no cap" : H.allocatedResetDaily ? `${H.allocatedPls?.toLocaleString?.() ?? H.allocatedPls} PLS/24h` : `${H.allocatedPls?.toLocaleString?.() ?? H.allocatedPls} PLS (as positions close)`;
      console.log(`  allocation=${alloc} maxPerTradePls=${H.maxPerTradePls?.toLocaleString?.() ?? H.maxPerTradePls} maxPerDay=${H.maxPerDay} maxOpenPositions=${H.maxOpenPositions || "unlimited"}`);
    }

    const opened24h = buysStmt.get(vault, dayAgo).n;
    const opened7d = buysStmt.get(vault, weekAgo).n;
    const closed7d = sellsStmt.get(vault, weekAgo).n;
    const open = openStmt.get(vault).n;
    const lastFire = lastFireStmt.get(vault).t;
    const lastFireAgo = lastFire ? `${Math.round((Date.now() / 1000 - lastFire) / 3600)}h ago` : "never";

    console.log(`  ACTUAL: ${opened24h} opened/24h, ${opened7d} opened/7d, ${closed7d} closed/7d, ${open} open now, last fire ${lastFireAgo}`);
  }

  console.log(
    "\nThis shows THAT a vault is quiet and what its own settings are, not WHY a specific " +
    "token got skipped for it - for that, check the keeper's own logs (pm2 logs icaria-keeper) " +
    "for lines mentioning that vault's address, e.g. 'holding cap ... would be exceeded' or " +
    "'AI did not clear the bar' or 'notifying instead of buying'.",
  );

  siteDb.close();
  keeperDb.close();
}

main();
