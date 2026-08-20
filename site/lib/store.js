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
    CREATE TABLE IF NOT EXISTS referrals (
      vault    TEXT PRIMARY KEY,
      referrer TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS referral_payouts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer   TEXT NOT NULL,
      amount_pls REAL NOT NULL,
      tx_hash    TEXT NOT NULL,
      paid_at    INTEGER NOT NULL
    );
  `);

  // Additive migration: databases created before "Buy Now" let someone type
  // their own amount predate this column. SQLite has no ALTER TABLE IF NOT
  // EXISTS, so probe first - same pattern keeper/src/db.ts already uses.
  {
    const cols = db.prepare("PRAGMA table_info(discovery_buy_requests)").all();
    if (!cols.some((c) => c.name === "amount_pls")) {
      db.exec("ALTER TABLE discovery_buy_requests ADD COLUMN amount_pls REAL");
    }
  }

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
 * Records that the owner wants this Discovery/Hunter Bot opportunity bought
 * now, for a specific amount they typed in themselves - same "site writes an
 * intent, keeper executes" split as requestClose - only the keeper's key can
 * call executeSwap, and the keeper only acts on an opportunity that already
 * passed its screen (see keeper/src/discovery.ts's
 * fetchBuyRequests/processBuyRequests). amountPls is null only for a request
 * made before this feature existed - the keeper falls back to the bot's own
 * configured amount in that case, never to spending nothing.
 */
function requestDiscoveryBuy(vault, opportunityId, nowMs, amountPls = null) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO discovery_buy_requests (vault, opportunity_id, requested_at, amount_pls) VALUES (?, ?, ?, ?)`,
    )
    .run(vault.toLowerCase(), opportunityId, nowMs, amountPls);
}

/** Every buy request this vault owner has made, handled or not - the keeper
 * is responsible for only acting on ones not already bought. */
function pendingDiscoveryBuyRequests(vault) {
  return getDb()
    .prepare(`SELECT opportunity_id, amount_pls FROM discovery_buy_requests WHERE vault = ?`)
    .all(vault.toLowerCase())
    .map((r) => ({ id: r.opportunity_id, amountPls: r.amount_pls }));
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
 * Referral program, off-chain by design (see the git history around this
 * feature for why: BotVault.sol's fee split is fixed on chain, and this
 * repo's already redeployed that contract twice in one night - a referral
 * split doesn't need that risk). A vault's referrer is bound at most once,
 * permanently, the same "no changing your mind later" rule vault ownership
 * itself already follows.
 */

/** null if this vault has no referrer on record. */
function getReferrer(vault) {
  const row = getDb()
    .prepare("SELECT referrer FROM referrals WHERE vault = ?")
    .get(vault.toLowerCase());
  return row ? row.referrer : null;
}

/**
 * Binds vault -> referrer, once. Re-submitting the SAME referrer is a
 * harmless no-op (the "I already have a vault, retry the request" case);
 * submitting a DIFFERENT one throws, since silently letting a binding move
 * would let someone redirect another wallet's already-earned referral credit
 * after the fact. Self-referral is rejected outright.
 */
function setReferrer(vault, referrer, nowMs) {
  vault = vault.toLowerCase();
  referrer = referrer.toLowerCase();
  if (vault === referrer) throw new Error("a vault cannot refer itself");
  const existing = getReferrer(vault);
  if (existing) {
    if (existing !== referrer) throw new Error("this vault already has a different referrer on record");
    return;
  }
  getDb()
    .prepare("INSERT INTO referrals (vault, referrer, bound_at) VALUES (?, ?, ?)")
    .run(vault, referrer, nowMs);
}

/** Every vault this wallet is credited as the referrer for. */
function getReferredVaults(referrer) {
  return getDb()
    .prepare("SELECT vault FROM referrals WHERE referrer = ?")
    .all(referrer.toLowerCase())
    .map((r) => r.vault);
}

/** Total PLS already paid out to this referrer across every payout batch. */
function getReferralPaidTotal(referrer) {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(amount_pls), 0) as total FROM referral_payouts WHERE referrer = ?")
    .get(referrer.toLowerCase());
  return row.total;
}

/** Records one payout batch. Called by the operator's manual payout script
 * (scripts/pay-referrals.js) after a real on-chain deposit into the
 * referrer's own vault, never by anything a site visitor can trigger. */
function recordReferralPayout(referrer, amountPls, txHash, nowMs) {
  getDb()
    .prepare("INSERT INTO referral_payouts (referrer, amount_pls, tx_hash, paid_at) VALUES (?, ?, ?, ?)")
    .run(referrer.toLowerCase(), amountPls, txHash, nowMs);
}

function resetForTests() {
  db = undefined;
}

module.exports = {
  getConfig, setConfig, requestClose, pendingCloseIds,
  requestDiscoveryBuy, pendingDiscoveryBuyRequests,
  requestAskBuy, pendingAskBuyRequests,
  getReferrer, setReferrer, getReferredVaults, getReferralPaidTotal, recordReferralPayout,
  resetForTests, DB_PATH,
};
