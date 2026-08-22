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
            tp_pct, sl_pct, trail_pct, time_exit_min, exit_mode, status, closed_at, proceeds_pls, close_reason
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
 * The sell tax the keeper's own honeypot/tax probe measured for this token,
 * in bps - null if it's never been screened. Used to discount a raw V2
 * getAmountsOut quote (see livePrice.js's quotePlsValue): that quote is pure
 * reserve arithmetic with no idea a token takes a cut on transfer, so an
 * undiscounted "current value" reads as far more than a real sale would
 * actually return. 0 (not null) if the token WAS screened and simply has no
 * measurable sell tax - only a token that's never been screened at all gets
 * null, so a caller can tell "no tax" from "no data" if it needs to.
 */
function getSellTaxBps(token) {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d.prepare(`SELECT sell_tax_bps FROM screened WHERE token = ?`).get(token.toLowerCase());
    return row ? row.sell_tax_bps : null;
  } catch {
    return null;
  }
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
 * feed (see `source`) - passed screens only. A failed screen (e.g. "this
 * pumped but looks like a trap") is still recorded in the opportunities
 * table for anyone reading the raw DB, but nobody visiting the dashboard
 * wants to see a scrolling feed of tokens they can't buy; an alert worth
 * acting on should be positive by the time it reaches a person. Filtered
 * here, not just hidden client-side, so `limit` still returns that many
 * REAL candidates instead of being padded out with rejects. Returns [] if
 * the table doesn't exist (a keeper build that predates Discovery Bot)
 * rather than throwing - same reasoning covers a keeper that predates the
 * stale/stale_reason columns (deploy the keeper before the site to avoid
 * a momentary empty feed after adding this feature).
 */
function getOpportunities(limit = 50) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(
      `SELECT id, token, ts, price_move_pct, liq_growth_pct, liq_pls, buy_tax_bps, sell_tax_bps,
              lp_locked_pct, owner_renounced, sellable, verdict, reason, narrative,
              source, rsi, macd_histogram, bollinger_percent_b, ai_recommend, ai_confidence, ai_reasoning,
              ai_suggested_amount_pls, stale, stale_reason, atr_pct, vol_ratio, signal_count
       FROM opportunities WHERE verdict = 'pass' ORDER BY ts DESC LIMIT ?`,
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

/**
 * Raw price ticks for a token since `sinceTs` (unix seconds), oldest first -
 * the same `prices` table the keeper's own candle/indicator math reads (see
 * keeper/src/candles.ts). Used by Ask Icaria (lib/askIcaria.js) to give the
 * AI actual price action and technicals instead of only tax/LP/renounce
 * facts. [] if the keeper.db file doesn't exist yet, or the token has no
 * price history on file (never watched, or watched too recently) - either
 * way "no price data" is a normal state here, not an error.
 */
function getRecentPrices(token, sinceTs) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(
      `SELECT ts, price, liq, vol FROM prices WHERE token = ? AND ts >= ? ORDER BY ts ASC`,
    ).all(token.toLowerCase(), sinceTs);
  } catch {
    return []; // no vol column yet on an older keeper.db - still usable without it
  }
}

/** Hunter IQ's lesson history for a vault, newest first - owner-typed
 * feedback and the bot's own self-written reflections on its losses and
 * misses (see keeper/src/hunter.ts's hunterLessons/reflectOnClosedLosses/
 * reflectOnMissedOpportunities). [] if the table doesn't exist (a keeper
 * build that predates Hunter IQ) rather than throwing. */
function getHunterLessons(vault, limit = 30) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(
      `SELECT id, source, text, position_id, opportunity_id, ts
       FROM hunter_lessons WHERE vault = ? ORDER BY ts DESC LIMIT ?`,
    ).all(vault.toLowerCase(), limit);
  } catch {
    return [];
  }
}

/**
 * Hunter Bot's own trades, each with the rationale that led to it - what
 * replaces the Opportunities panel for Hunter (see components/
 * HunterIQPanel.jsx): a justified trade feed instead of a pending-approval
 * queue. Joins fires (the actual executed trade) back to the opportunity
 * that caused it via discovery_actions' tx_hash link (see hunter.ts's
 * executeHunterBuy) - a fire with no matching opportunity still shows up,
 * just without a rationale.
 */
function getHunterTrades(vault, limit = 30) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(`
      SELECT f.id, f.token, f.ts, f.amount, f.fee, f.tx_hash AS txHash,
             o.narrative, o.ai_reasoning AS aiReasoning, o.signal_count AS signalCount
      FROM fires f
      LEFT JOIN discovery_actions a ON a.vault = f.vault AND a.tx_hash = f.tx_hash AND a.action = 'bought'
      LEFT JOIN opportunities o ON o.id = a.opportunity_id
      WHERE f.vault = ? AND f.bot = 'hunter'
      ORDER BY f.ts DESC LIMIT ?
    `).all(vault.toLowerCase(), limit);
  } catch {
    return [];
  }
}

function resetForTests() {
  if (db) db.close();
  db = undefined;
  triedOpen = false;
}

module.exports = {
  getPositions, getRecentFires, getTotalFees, getV4PoolsForToken,
  getOpportunities, getDiscoveryActionsForVault, getRecentPrices,
  getHunterLessons, getHunterTrades, getSellTaxBps,
  resetForTests, resolveDbPath,
};
