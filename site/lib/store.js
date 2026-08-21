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
    CREATE TABLE IF NOT EXISTS discovery_buy_requests (
      vault          TEXT NOT NULL,
      opportunity_id INTEGER NOT NULL,
      requested_at   INTEGER NOT NULL,
      PRIMARY KEY (vault, opportunity_id)
    );
    CREATE TABLE IF NOT EXISTS ask_buy_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      vault        TEXT NOT NULL,
      token        TEXT NOT NULL,
      amount_pls   REAL NOT NULL,
      requested_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hunter_feedback_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      vault        TEXT NOT NULL,
      text         TEXT NOT NULL,
      requested_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hunter_chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      vault      TEXT NOT NULL,
      role       TEXT NOT NULL,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hunter_chat_messages_vault_id ON hunter_chat_messages(vault, id);
  `);
  return db;
}

/**
 * Returns a vault's stored config, or the safe empty default if none is set
 * yet. Merged over emptyConfig() rather than returned as-is: a config saved
 * before a feature existed (discovery, at first save time) simply lacks that
 * key in its stored JSON, and without this merge the client would crash
 * reading e.g. config.discovery.enabled on undefined. A top-level merge is
 * enough because normalizeConfig() always writes each section as a complete
 * object, never a partial one, so there's nothing to merge within a section.
 */
function getConfig(vault) {
  const row = getDb()
    .prepare("SELECT config FROM vault_configs WHERE vault = ?")
    .get(vault.toLowerCase());
  if (!row) return emptyConfig();
  return { ...emptyConfig(), ...JSON.parse(row.config) };
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

/**
 * Records that the owner wants this Discovery Bot opportunity bought now.
 * Same "site writes an intent, keeper executes" split as requestClose - only
 * the keeper's key can call executeSwap, and the keeper only acts on an
 * opportunity that already passed its screen (see keeper/src/discovery.ts's
 * fetchBuyRequests/processBuyRequests).
 */
function requestDiscoveryBuy(vault, opportunityId, nowMs) {
  getDb()
    .prepare(`INSERT OR IGNORE INTO discovery_buy_requests (vault, opportunity_id, requested_at) VALUES (?, ?, ?)`)
    .run(vault.toLowerCase(), opportunityId, nowMs);
}

/** Every opportunity ID this vault owner has asked to buy, handled or not -
 * the keeper is responsible for only acting on ones not already bought. */
function pendingDiscoveryBuyIds(vault) {
  return getDb()
    .prepare(`SELECT opportunity_id FROM discovery_buy_requests WHERE vault = ?`)
    .all(vault.toLowerCase())
    .map((r) => r.opportunity_id);
}

/**
 * Records an Ask Icaria "buy it" request - unlike the Discovery/Hunter buy
 * requests above, there's no pre-existing opportunity catalog entry to
 * reference, since the user typed this token in themselves. The token and
 * amount are recorded directly, and each request gets its own id so the
 * keeper can track exactly which ones it's already filled (see keeper/src/
 * ask.ts's askBuyFires, the same one-shot-per-id pattern limitFires uses).
 * No dedup on insert - genuinely asking to buy the same token twice is a
 * valid, separate request, not a duplicate click.
 */
function requestAskBuy(vault, token, amountPls, nowMs) {
  const info = getDb()
    .prepare(`INSERT INTO ask_buy_requests (vault, token, amount_pls, requested_at) VALUES (?, ?, ?, ?)`)
    .run(vault.toLowerCase(), token.toLowerCase(), amountPls, nowMs);
  return Number(info.lastInsertRowid);
}

/** Every ask-buy request this vault owner has made, handled or not - the
 * keeper is responsible for only acting on ones it hasn't already filled. */
function pendingAskBuyRequests(vault) {
  return getDb()
    .prepare(`SELECT id, token, amount_pls, requested_at FROM ask_buy_requests WHERE vault = ? ORDER BY id ASC`)
    .all(vault.toLowerCase())
    .map((r) => ({ id: r.id, token: r.token, amountPls: r.amount_pls, requestedAt: r.requested_at }));
}

/**
 * Records Hunter IQ feedback/coaching for this vault's own Hunter Bot - from
 * the standalone feedback box, or (now) from a Talk to Your Hunter chat
 * message, which queues into this exact same pipeline (see hunter-chat.js).
 * The keeper polls pendingHunterFeedback on its own schedule and turns each
 * request into a lesson (see keeper/src/hunter.ts's ingestOwnerFeedback) -
 * same "site writes an intent, keeper's own DB is where it becomes real
 * bot memory" split as every other request table here.
 */
function requestHunterFeedback(vault, text, nowMs) {
  const info = getDb()
    .prepare(`INSERT INTO hunter_feedback_requests (vault, text, requested_at) VALUES (?, ?, ?)`)
    .run(vault.toLowerCase(), text, nowMs);
  return Number(info.lastInsertRowid);
}

/** Every feedback request this vault owner has made, handled or not - the
 * keeper is responsible for only ingesting ones it hasn't already turned
 * into a lesson (see keeper/src/db.ts's hunterLessons.alreadyIngestedOwnerRequest). */
function pendingHunterFeedback(vault) {
  return getDb()
    .prepare(`SELECT id, text, requested_at FROM hunter_feedback_requests WHERE vault = ? ORDER BY id ASC`)
    .all(vault.toLowerCase())
    .map((r) => ({ id: r.id, text: r.text, requestedAt: r.requested_at }));
}

/** One message in a vault's Talk to Your Hunter thread - role is 'owner' or
 * 'hunter'. Persisted here (not just shown in the moment) so the whole
 * conversation survives a page reload, not just whatever was on screen when
 * the owner left. */
function addHunterChatMessage(vault, role, text, nowMs) {
  getDb()
    .prepare(`INSERT INTO hunter_chat_messages (vault, role, text, created_at) VALUES (?, ?, ?, ?)`)
    .run(vault.toLowerCase(), role, text, nowMs);
}

/** The full thread so far, oldest first - capped at `limit` most recent
 * messages so a very long-running conversation doesn't grow the payload
 * without bound. */
function getHunterChatMessages(vault, limit = 200) {
  const rows = getDb()
    .prepare(`SELECT id, role, text, created_at FROM hunter_chat_messages WHERE vault = ? ORDER BY id DESC LIMIT ?`)
    .all(vault.toLowerCase(), limit);
  return rows.reverse();
}

function resetForTests() {
  db = undefined;
}

module.exports = {
  getConfig, setConfig, requestClose, pendingCloseIds,
  requestDiscoveryBuy, pendingDiscoveryBuyIds,
  requestAskBuy, pendingAskBuyRequests,
  requestHunterFeedback, pendingHunterFeedback,
  addHunterChatMessage, getHunterChatMessages,
  resetForTests, DB_PATH,
};
