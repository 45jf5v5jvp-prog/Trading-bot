const path = require("path");
const Database = require("better-sqlite3");
const { emptyConfig } = require("./schema");

const DB_PATH = process.env.SITE_DB_PATH || path.join(process.cwd(), "site.db");

let db;
function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_configs (
      vault      TEXT PRIMARY KEY,
      config     TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS close_requests (
      vault        TEXT NOT NULL,
      position_id  INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (vault, position_id)
    );
  `);
  return db;
}

/** Returns a vault's stored config, or the safe empty default if none is set yet. */
function getConfig(vault) {
  const row = getDb()
    .prepare("SELECT config FROM vault_configs WHERE vault = ?")
    .get(vault.toLowerCase());
  if (!row) return emptyConfig();
  return JSON.parse(row.config);
}

/** Overwrites a vault's stored config. Caller is responsible for validating and authorizing first. */
function setConfig(vault, config, nowMs) {
  getDb()
    .prepare(
      `INSERT INTO vault_configs (vault, config, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(vault) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    )
    .run(vault.toLowerCase(), JSON.stringify(config), nowMs);
}

/**
 * Records that the owner wants this position closed. The keeper (not this
 * site) actually executes the sell - it polls pendingCloseIds on its own
 * schedule and forces an exit, the same mechanism take-profit/stop-loss
 * already use, since only the keeper's key can call the vault's onlyExecutor
 * executeSwap. INSERT OR IGNORE so clicking the button twice before the
 * keeper's next pass is a harmless no-op, not a duplicate request.
 */
function requestClose(vault, positionId, nowMs) {
  getDb()
    .prepare(`INSERT OR IGNORE INTO close_requests (vault, position_id, requested_at) VALUES (?, ?, ?)`)
    .run(vault.toLowerCase(), positionId, nowMs);
}

/** Every position ID this vault owner has asked to close, handled or not -
 * the keeper is responsible for only acting on ones still actually open. */
function pendingCloseIds(vault) {
  return getDb()
    .prepare(`SELECT position_id FROM close_requests WHERE vault = ?`)
    .all(vault.toLowerCase())
    .map((r) => r.position_id);
}

function resetForTests() {
  db = undefined;
}

module.exports = { getConfig, setConfig, requestClose, pendingCloseIds, resetForTests, DB_PATH };
