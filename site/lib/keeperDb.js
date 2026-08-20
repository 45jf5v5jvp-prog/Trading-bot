const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function resolveDbPath() {
  return process.env.KEEPER_DB_PATH || path.join(process.cwd(), "..", "keeper", "keeper.db");
}

/**
 * Read-only access to the KEEPER's own database (positions, fires) - a
 * completely separate file from this site's own site.db, which only ever
 * holds config. Opened with { readonly: true } deliberately: nothing in the
 * site should ever be able to write to the keeper's live trading data, even
 * by accident. If the file doesn't exist yet (e.g. local dev with no keeper
 * running, or a fresh deploy before the keeper's first run), every function
 * here returns empty results rather than throwing - a missing trade history
 * is not an error, it just means nothing has happened yet.
 */
let db;
let triedOpen = false;
function getDb() {
  if (triedOpen) return db;
  triedOpen = true;
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) return undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    db = undefined;
  }
  return db;
}

function getPositions(vault) {
  const d = getDb();
  if (!d) return { open: [], closed: [] };
  const rows = d.prepare(
    `SELECT id, bot, token, opened_at, entry_price, spent_pls, tokens_held, high_water,
            tp_pct, sl_pct, trail_pct, time_exit_min, status, closed_at, proceeds_pls, close_reason
     FROM positions WHERE vault = ? ORDER BY opened_at DESC LIMIT 100`,
  ).all(vault.toLowerCase());
  return {
    open: rows.filter((r) => r.status === "open"),
    closed: rows.filter((r) => r.status !== "open"),
  };
}

function getRecentFires(vault, limit = 25) {
  const d = getDb();
  if (!d) return [];
  return d.prepare(
    `SELECT id, bot, token, ts, amount, fee, tx_hash FROM fires
     WHERE vault = ? ORDER BY ts DESC LIMIT ?`,
  ).all(vault.toLowerCase(), limit);
}

/** Every platform fee (PLS) this vault has ever generated, summed - the
 * referral program's input: a referrer is owed a fixed share of exactly this
 * number, across every vault they're credited for (see lib/store.js's
 * getReferredVaults). 0 if the keeper.db file doesn't exist yet, same
 * "missing history isn't an error" convention as the rest of this file. */
function getTotalFees(vault) {
  const d = getDb();
  if (!d) return 0;
  const row = d.prepare(`SELECT COALESCE(SUM(fee), 0) as total FROM fires WHERE vault = ?`).get(vault.toLowerCase());
  return row.total;
}

/**
 * Every V4 pool the keeper's scanner has recorded for a token. V4 has no
 * on-chain "getPool(tokenA, tokenB, fee)" lookup the way V2/V3 do - a
 * pool's full PoolKey (both currencies, fee, tickSpacing, hooks) IS its
 * identity, discoverable only by having seen its Initialize event - so
 * pricing a V4-only token from the site means reading the same table the
 * keeper itself relies on (keeper/src/db.ts's v4Pools). Returns [] if the
 * table doesn't exist (a PulseChain keeper.db, which has no V4 code at
 * all) rather than throwing.
 */
function getV4PoolsForToken(token) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(
      `SELECT currency0, currency1, fee, tick_spacing, hooks FROM v4_pools WHERE token = ?`,
    ).all(token.toLowerCase());
  } catch {
    return []; // no v4_pools table on this deployment - not an error
  }
}

/**
 * Discovery Bot's and Hunter Bot's findings, newest first, in one shared
 * feed (see `source`). Every opportunity a detector both found and screened
 * is included - a failed screen is shown too (with its reason), never
 * hidden, since "this pumped but looks like a trap" (or "this looked
 * oversold but liquidity looks pulled") is useful information even when
 * it's not buyable. Returns [] if the table doesn't exist (a keeper build
 * that predates Discovery Bot) rather than throwing.
 */
function getOpportunities(limit = 50) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(
      `SELECT id, token, ts, price_move_pct, liq_growth_pct, liq_pls, buy_tax_bps, sell_tax_bps,
              lp_locked_pct, owner_renounced, sellable, verdict, reason, narrative,
              source, rsi, macd_histogram, bollinger_percent_b, ai_recommend, ai_confidence, ai_reasoning,
              ai_suggested_amount_pls
       FROM opportunities ORDER BY ts DESC LIMIT ?`,
    ).all(limit);
  } catch {
    return [];
  }
}

/** What this vault has already done with each opportunity it's seen -
 * "notified" or "bought" - keyed by opportunity_id, so the site can grey out
 * a Buy Now button already acted on instead of re-offering it. */
function getDiscoveryActionsForVault(vault) {
  const d = getDb();
  if (!d) return {};
  try {
    const rows = d.prepare(
      `SELECT opportunity_id, action, tx_hash FROM discovery_actions WHERE vault = ?`,
    ).all(vault.toLowerCase());
    const out = {};
    for (const r of rows) out[r.opportunity_id] = { action: r.action, txHash: r.tx_hash };
    return out;
  } catch {
    return {};
  }
}

function resetForTests() {
  if (db) db.close();
  db = undefined;
  triedOpen = false;
}

module.exports = {
  getPositions, getRecentFires, getTotalFees, getV4PoolsForToken,
  getOpportunities, getDiscoveryActionsForVault,
  resetForTests, resolveDbPath,
};
