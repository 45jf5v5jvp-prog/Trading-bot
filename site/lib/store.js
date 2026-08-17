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

function resetForTests() {
  db = undefined;
}

module.exports = { getConfig, setConfig, resetForTests, DB_PATH };
