const path = require("path");
const crypto = require("crypto");
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
    CREATE TABLE IF NOT EXISTS deposit_notices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      vault        TEXT NOT NULL,
      token        TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS referral_codes (
      code       TEXT PRIMARY KEY,
      referrer   TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_referrers (
      owner      TEXT PRIMARY KEY,
      referrer   TEXT NOT NULL,
      locked_at  INTEGER NOT NULL
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
 * Records Hunter IQ feedback the owner typed on the dashboard - same
 * "site writes an intent, keeper picks it up" split as everything else here.
 * The keeper (hunter.ts's ingestOwnerFeedback) polls this per vault and
 * copies each new row into its own hunter_lessons table, which is what
 * future personalized AI reviews actually read from - this table is only
 * ever the pending inbox, not the bot's long-term memory. No dedup on
 * insert - leaving two pieces of feedback in a row is a normal thing to do,
 * not a duplicate click.
 */
function requestHunterFeedback(vault, text, nowMs) {
  const info = getDb()
    .prepare(`INSERT INTO hunter_feedback_requests (vault, text, requested_at) VALUES (?, ?, ?)`)
    .run(vault.toLowerCase(), text, nowMs);
  return Number(info.lastInsertRowid);
}

/** Every piece of feedback this vault owner has ever left, oldest first -
 * the keeper is responsible for only ingesting ones it hasn't seen yet
 * (tracked on its own side, via hunter_lessons.owner_request_id). */
function pendingHunterFeedback(vault) {
  return getDb()
    .prepare(`SELECT id, text FROM hunter_feedback_requests WHERE vault = ? ORDER BY id ASC`)
    .all(vault.toLowerCase());
}

/**
 * Talk to Your Hunter - the message thread itself, separate from
 * hunter_feedback_requests above (which the keeper drains into real lessons;
 * this is purely display history so a returning owner sees the conversation
 * they already had, not a blank chat every visit). Every owner message here
 * is ALSO recorded via requestHunterFeedback - see pages/api/vaults/
 * [address]/hunter-chat.js - so a chat message shapes the bot exactly like
 * one typed into a plain feedback box would, on top of getting a live reply.
 */
function addHunterChatMessage(vault, role, text, nowMs) {
  getDb()
    .prepare(`INSERT INTO hunter_chat_messages (vault, role, text, created_at) VALUES (?, ?, ?, ?)`)
    .run(vault.toLowerCase(), role, text, nowMs);
}

/** Full thread for a vault, oldest first - capped so one very long-lived
 * vault's history can't make every page load slower forever. */
function getHunterChatMessages(vault, limit = 200) {
  const rows = getDb()
    .prepare(`SELECT id, role, text, created_at FROM hunter_chat_messages WHERE vault = ? ORDER BY id DESC LIMIT ?`)
    .all(vault.toLowerCase(), limit);
  return rows.reverse();
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

function requestDepositNotice(vault, token, nowMs) {
  const info = getDb()
    .prepare(`INSERT INTO deposit_notices (vault, token, requested_at) VALUES (?, ?, ?)`)
    .run(vault.toLowerCase(), token.toLowerCase(), nowMs);
  return Number(info.lastInsertRowid);
}

// 24h - plenty of time for a wallet transfer to land, but bounded so a
// mistyped address or an abandoned deposit doesn't have the keeper checking
// an empty balance forever. The keeper's own dedup is "does an open deposit
// position already exist for this token" (see keeper/src/deposits.ts) - this
// window only bounds how long it keeps trying before that's ever true.
const DEPOSIT_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pendingDepositNotices(vault) {
  return getDb()
    .prepare(`SELECT id, token, requested_at FROM deposit_notices WHERE vault = ? AND requested_at >= ? ORDER BY id ASC`)
    .all(vault.toLowerCase(), Date.now() - DEPOSIT_NOTICE_MAX_AGE_MS)
    .map((r) => ({ id: r.id, token: r.token, requestedAt: r.requested_at }));
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
 * Referral Protections: a WALLET's referrer, not just a vault's, decided
 * once and permanent from then on. Without this, someone could accept a
 * real referral on their first vault, then open a second vault under their
 * own referral code (or no code at all) and just trade there instead - the
 * original referrer did the actual work of sending them here and would
 * never see a cent. Locking at the wallet level means every vault that
 * wallet EVER creates is credited to the same referrer it was first
 * credited to, no matter what code shows up on a later vault.
 */
function getWalletReferrer(owner) {
  const row = getDb()
    .prepare("SELECT referrer FROM wallet_referrers WHERE owner = ?")
    .get(owner.toLowerCase());
  return row ? row.referrer : null;
}

/** First write wins, permanently - same "no changing your mind later" rule
 * as everything else in this program. Re-locking to the SAME referrer is a
 * harmless no-op; the point is nothing can ever move it to a different one. */
function lockWalletReferrer(owner, referrer, nowMs) {
  getDb()
    .prepare("INSERT OR IGNORE INTO wallet_referrers (owner, referrer, locked_at) VALUES (?, ?, ?)")
    .run(owner.toLowerCase(), referrer.toLowerCase(), nowMs);
}

/**
 * Binds vault -> referrer, once - except the referrer actually recorded is
 * never just whatever was submitted. `owner` is the vault's on-chain owner
 * (verified by signature before this is ever called - see lib/auth.js), and
 * the real source of truth is that OWNER's wallet-level lock (see
 * getWalletReferrer/lockWalletReferrer above): if this owner already has a
 * locked referrer - from this vault or from a completely different one -
 * that locked referrer wins, silently, no matter what code this call was
 * given (never throws over a mismatch; it just keeps the one already on
 * record). Only a wallet's truly first-ever binding (no vault-level record,
 * no wallet-level lock yet) actually sets the referrer, and that act is
 * exactly what locks the wallet going forward. Self-referral is rejected
 * outright - compared against the OWNER, not the vault address, since a
 * vault contract's own address is never equal to any wallet's anyway.
 */
function setReferrer(vault, referrer, nowMs, owner) {
  vault = vault.toLowerCase();
  referrer = referrer.toLowerCase();
  owner = owner.toLowerCase();
  if (owner === referrer) throw new Error("a wallet cannot refer itself");

  const existingVaultReferrer = getReferrer(vault);
  const existingWalletReferrer = getWalletReferrer(owner);
  // Whichever of these is already on record wins outright - an existing
  // vault-level binding first (this exact vault already has its answer),
  // then the wallet-level lock (a different vault already decided it for
  // this whole wallet). Only when NEITHER exists yet does the freshly
  // submitted referrer actually count, and that's the act that creates
  // both records at once.
  const lockedReferrer = existingVaultReferrer || existingWalletReferrer || referrer;

  if (!existingVaultReferrer) {
    getDb()
      .prepare("INSERT INTO referrals (vault, referrer, bound_at) VALUES (?, ?, ?)")
      .run(vault, lockedReferrer, nowMs);
  }
  lockWalletReferrer(owner, lockedReferrer, nowMs);
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

/**
 * Referral links carry an opaque code instead of a wallet address (see
 * git history: the raw address used to go straight into the shareable
 * link, which meant pasting the link into an explorer doxxed the referrer).
 * A code is generated once per wallet, on first request, and is permanent -
 * the code -> address direction is never returned by any public API, only
 * resolved server-side when a vault actually binds to a referrer.
 */
function getReferralCode(referrer) {
  const row = getDb()
    .prepare("SELECT code FROM referral_codes WHERE referrer = ?")
    .get(referrer.toLowerCase());
  return row ? row.code : null;
}

function getOrCreateReferralCode(referrer) {
  referrer = referrer.toLowerCase();
  const existing = getReferralCode(referrer);
  if (existing) return existing;
  // A collision at 16 hex chars (64 bits) is astronomically unlikely, but
  // retry on one rather than trust that - the UNIQUE constraint on referrer
  // makes a collision fail loudly instead of silently handing out someone
  // else's code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = crypto.randomBytes(8).toString("hex");
    try {
      getDb()
        .prepare("INSERT INTO referral_codes (code, referrer, created_at) VALUES (?, ?, ?)")
        .run(code, referrer, Date.now());
      return code;
    } catch (e) {
      if (!String(e.message).includes("UNIQUE")) throw e;
    }
  }
  throw new Error("could not generate a unique referral code");
}

/** The wallet a referral code belongs to, or null if unknown. */
function resolveReferralCode(code) {
  const row = getDb()
    .prepare("SELECT referrer FROM referral_codes WHERE code = ?")
    .get(code.toLowerCase());
  return row ? row.referrer : null;
}

function resetForTests() {
  db = undefined;
}

module.exports = {
  getConfig, setConfig, requestClose, pendingCloseIds,
  requestDiscoveryBuy, pendingDiscoveryBuyRequests,
  requestHunterFeedback, pendingHunterFeedback,
  addHunterChatMessage, getHunterChatMessages,
  requestAskBuy, pendingAskBuyRequests,
  requestDepositNotice, pendingDepositNotices,
  getReferrer, setReferrer, getWalletReferrer, lockWalletReferrer,
  getReferredVaults, getReferralPaidTotal, recordReferralPayout,
  getOrCreateReferralCode, resolveReferralCode,
  resetForTests, DB_PATH,
};
