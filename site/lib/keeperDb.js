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

// narrative/aiReasoning/signalCount: the buy-time rationale, joined in here
// for every position (open or closed, any bot) via source_tx_hash. Only
// Hunter and Discovery buys actually go through opportunities/
// discovery_actions, so a Launch/Snipe/Rules/Limit/Ask position just gets
// null here, same as it always would have - nothing to show a rationale for
// on those, not a bug.
const POSITION_COLUMNS = `p.id, p.bot, p.token, p.opened_at, p.entry_price, p.spent_pls, p.tokens_held, p.high_water,
            p.tp_pct, p.sl_pct, p.trail_pct, p.time_exit_min, p.exit_mode, p.status, p.closed_at,
            p.proceeds_pls, p.close_reason, p.last_retry_at,
            o.narrative, o.ai_reasoning AS aiReasoning, o.signal_count AS signalCount`;
const POSITION_JOINS = `FROM positions p
     LEFT JOIN fires f ON f.tx_hash = p.source_tx_hash
     LEFT JOIN discovery_actions a ON a.vault = f.vault AND a.tx_hash = f.tx_hash AND a.action = 'bought'
     LEFT JOIN opportunities o ON o.id = a.opportunity_id`;

function getPositions(vault) {
  const d = getDb();
  if (!d) return { open: [], closed: [] };
  const v = vault.toLowerCase();

  // Open positions are NEVER capped - every one is live and actionable, not
  // history. Found live (2026-08-24): the old query capped open+closed
  // COMBINED at 100 rows, ordered by opened_at - a vault that traded
  // heavily that same day had its own currently-open positions crowded out
  // by newer closed trades, everywhere this list is read (Current Holdings,
  // the round-trip/lifetime figures fixed earlier tonight). A vault owner
  // with 50 real open positions saw only ~8 of them - unacceptable for
  // something the owner needs to see and be able to act on in full.
  const open = d.prepare(
    `SELECT ${POSITION_COLUMNS} ${POSITION_JOINS} WHERE p.vault = ? AND p.status = 'open' ORDER BY p.opened_at DESC`,
  ).all(v);

  // Closed/stuck history IS still capped, deliberately - unlike an open
  // position, nothing about an old closed trade needs action, and this list
  // only grows across a vault's lifetime. Ordered by when it actually
  // CLOSED, not opened (closed_at, not opened_at - a position opened early
  // but closed late, or the reverse, wouldn't otherwise sort as "most
  // recent" correctly); COALESCE treats a stuck position's null closed_at
  // as unclosed rather than crashing the sort.
  const closed = d.prepare(
    `SELECT ${POSITION_COLUMNS} ${POSITION_JOINS} WHERE p.vault = ? AND p.status != 'open'
     ORDER BY COALESCE(p.closed_at, 0) DESC LIMIT 100`,
  ).all(v);

  return { open, closed };
}

/**
 * True lifetime closed-trade totals per bot, unbounded - NOT derived from
 * getPositions' own list, which caps at the vault's 100 most recently
 * OPENED positions (open and closed combined, across every bot). Found
 * live (2026-08-24): a vault trading fast enough burns through 100
 * positions in about a day, so anything computed from that list and
 * labeled "lifetime" (BotCard's stat line, the P&L Snapshot's "All" tab)
 * was quietly losing real, older closed trades from both the round-trip
 * count and the realized total the more active the vault got - the exact
 * opposite of what a hyperactive bot's owner would expect from "lifetime."
 * This is a separate, unbounded aggregate query instead, grouped by bot so
 * callers can look up their own bot's row (or sum every row for a
 * vault-wide total). 'closed' here means proceeds_pls is set - a stuck
 * position never has one and is correctly excluded, same convention
 * pnl.js's own realized-P&L logic already uses.
 */
function getLifetimeStats(vault) {
  const d = getDb();
  if (!d) return [];
  return d.prepare(
    `SELECT bot, COUNT(*) as closedCount, COALESCE(SUM(proceeds_pls - spent_pls), 0) as realizedPls
     FROM positions WHERE vault = ? AND status = 'closed' AND proceeds_pls IS NOT NULL
     GROUP BY bot`,
  ).all(vault.toLowerCase());
}

function getRecentFires(vault, limit = 25) {
  const d = getDb();
  if (!d) return [];
  return d.prepare(
    `SELECT id, bot, token, ts, amount, fee, tx_hash, side FROM fires
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

function resetForTests() {
  if (db) db.close();
  db = undefined;
  triedOpen = false;
}

module.exports = {
  getPositions, getLifetimeStats, getRecentFires, getTotalFees, getV4PoolsForToken,
  getOpportunities, getDiscoveryActionsForVault, getRecentPrices,
  getSellTaxBps,
  resetForTests, resolveDbPath,
};
