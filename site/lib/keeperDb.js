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

function resetForTests() {
  if (db) db.close();
  db = undefined;
  triedOpen = false;
}

module.exports = { getPositions, getRecentFires, resetForTests, resolveDbPath };
