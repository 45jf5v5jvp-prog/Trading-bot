import Database from "better-sqlite3";
import { CFG } from "./config.js";

export const db = new Database(CFG.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS prices (
  token   TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  price   REAL NOT NULL,
  liq     REAL NOT NULL,
  PRIMARY KEY (token, ts)
);
CREATE INDEX IF NOT EXISTS prices_token_ts ON prices(token, ts DESC);

CREATE TABLE IF NOT EXISTS watched (
  token      TEXT PRIMARY KEY,
  symbol     TEXT,
  decimals   INTEGER DEFAULT 18,
  pair       TEXT,
  first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS screened (
  token       TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  sellable    INTEGER NOT NULL,
  loss_bps    INTEGER NOT NULL,
  buy_tax_bps INTEGER NOT NULL,
  sell_tax_bps INTEGER NOT NULL,
  lp_locked_pct REAL NOT NULL,
  deployer_pct  REAL NOT NULL,
  liq_pls     REAL NOT NULL,
  verdict     TEXT NOT NULL,
  reason      TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vault       TEXT NOT NULL,
  bot         TEXT NOT NULL,
  token       TEXT NOT NULL,
  opened_at   INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  spent_pls   REAL NOT NULL,
  tokens_held TEXT NOT NULL,
  high_water  REAL NOT NULL,
  tp_pct      REAL,
  sl_pct      REAL,
  trail_pct   REAL,
  time_exit_min INTEGER,
  status      TEXT NOT NULL DEFAULT 'open',
  closed_at   INTEGER,
  proceeds_pls REAL,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS positions_open ON positions(status, vault);

CREATE TABLE IF NOT EXISTS fires (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  vault    TEXT NOT NULL,
  bot      TEXT NOT NULL,
  token    TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  amount   REAL NOT NULL,
  fee      REAL NOT NULL,
  tx_hash  TEXT
);
CREATE INDEX IF NOT EXISTS fires_vault_ts ON fires(vault, ts DESC);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS limit_fires (
  vault    TEXT NOT NULL,
  order_id TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  tx_hash  TEXT,
  PRIMARY KEY (vault, order_id)
);

CREATE TABLE IF NOT EXISTS ask_buy_fires (
  vault      TEXT NOT NULL,
  request_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  tx_hash    TEXT,
  PRIMARY KEY (vault, request_id)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token           TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  price_move_pct  REAL NOT NULL,
  liq_growth_pct  REAL NOT NULL,
  liq_pls         REAL NOT NULL,
  buy_tax_bps     INTEGER,
  sell_tax_bps    INTEGER,
  lp_locked_pct   REAL,
  owner_renounced INTEGER,
  sellable        INTEGER NOT NULL,
  verdict         TEXT NOT NULL,
  reason          TEXT,
  narrative       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS opportunities_token_ts ON opportunities(token, ts DESC);

CREATE TABLE IF NOT EXISTS discovery_actions (
  vault          TEXT NOT NULL,
  opportunity_id INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  action         TEXT NOT NULL,
  tx_hash        TEXT,
  PRIMARY KEY (vault, opportunity_id)
);

CREATE TABLE IF NOT EXISTS ai_exit_requests (
  position_id INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  reason      TEXT NOT NULL
);
`);

// Additive migration: databases created before the retry-storm fix predate
// this column. SQLite has no ALTER TABLE IF NOT EXISTS, so probe first.
{
  const cols = db.prepare("PRAGMA table_info(positions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "fail_count")) {
    db.exec("ALTER TABLE positions ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0");
  }
  // Set once at open time, not read live from the vault's current Hunter Bot
  // config - so flipping the setting later never retroactively changes how
  // an already-open position is managed. NULL for every non-Hunter position.
  if (!cols.some((c) => c.name === "exit_mode")) {
    db.exec("ALTER TABLE positions ADD COLUMN exit_mode TEXT");
  }
}

// Additive migration: Hunter Bot reuses the opportunities feed/UI/buy-request
// pipeline discovery.ts already built rather than duplicating it, tagged by
// `source` and carrying its own indicator + AI-verdict columns alongside
// discovery.ts's price/liquidity ones.
{
  const cols = db.prepare("PRAGMA table_info(opportunities)").all() as { name: string }[];
  const add = (name: string, ddl: string) => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE opportunities ADD COLUMN ${ddl}`);
  };
  add("source", "source TEXT NOT NULL DEFAULT 'discovery'");
  add("rsi", "rsi REAL");
  add("macd_histogram", "macd_histogram REAL");
  add("bollinger_percent_b", "bollinger_percent_b REAL");
  add("ai_recommend", "ai_recommend INTEGER");
  add("ai_confidence", "ai_confidence TEXT");
  add("ai_reasoning", "ai_reasoning TEXT");
  add("ai_suggested_amount_pls", "ai_suggested_amount_pls REAL");
}

export const meta = {
  get(k: string, d = ""): string {
    const r = db.prepare("SELECT v FROM meta WHERE k=?").get(k) as { v: string } | undefined;
    return r?.v ?? d;
  },
  set(k: string, v: string): void {
    db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  },
};

export interface PricePoint { ts: number; price: number; liq: number }

export const prices = {
  insert: db.prepare("INSERT OR REPLACE INTO prices(token,ts,price,liq) VALUES(?,?,?,?)"),

  since(token: string, fromTs: number): PricePoint[] {
    return db.prepare("SELECT ts,price,liq FROM prices WHERE token=? AND ts>=? ORDER BY ts ASC")
      .all(token.toLowerCase(), fromTs) as PricePoint[];
  },
  latest(token: string): PricePoint | undefined {
    return db.prepare("SELECT ts,price,liq FROM prices WHERE token=? ORDER BY ts DESC LIMIT 1")
      .get(token.toLowerCase()) as PricePoint | undefined;
  },
  /** How many hours of history exist. Decides whether a rule can arm. */
  coverageHours(token: string): number {
    const r = db.prepare("SELECT MIN(ts) a, MAX(ts) b FROM prices WHERE token=?")
      .get(token.toLowerCase()) as { a: number | null; b: number | null };
    if (!r.a || !r.b) return 0;
    return (r.b - r.a) / 3600;
  },
  prune(olderThan: number): void {
    db.prepare("DELETE FROM prices WHERE ts < ?").run(olderThan);
  },
};

/**
 * One-shot marker for a filled limit order, keyed by the order's own id
 * (not by token) - a vault can have several orders on the same token (a
 * buy target and a sell target, or two sell targets at different prices),
 * and each needs its own independent fired/not-fired state.
 */
export const limitFires = {
  has(vault: string, orderId: string): boolean {
    const r = db.prepare("SELECT 1 FROM limit_fires WHERE vault=? AND order_id=?")
      .get(vault.toLowerCase(), orderId);
    return Boolean(r);
  },
  record(vault: string, orderId: string, txHash?: string): void {
    db.prepare(`INSERT OR REPLACE INTO limit_fires(vault,order_id,ts,tx_hash) VALUES(?,?,?,?)`)
      .run(vault.toLowerCase(), orderId, Math.floor(Date.now() / 1000), txHash ?? null);
  },
};

/** One-shot marker for a filled Ask Icaria buy request, keyed by the site's
 * own autoincrement request id - same "fire once, never re-fire" shape as
 * limitFires. */
export const askBuyFires = {
  has(vault: string, requestId: number): boolean {
    const r = db.prepare("SELECT 1 FROM ask_buy_fires WHERE vault=? AND request_id=?")
      .get(vault.toLowerCase(), requestId);
    return Boolean(r);
  },
  record(vault: string, requestId: number, txHash?: string): void {
    db.prepare(`INSERT OR REPLACE INTO ask_buy_fires(vault,request_id,ts,tx_hash) VALUES(?,?,?,?)`)
      .run(vault.toLowerCase(), requestId, Math.floor(Date.now() / 1000), txHash ?? null);
  },
};

/**
 * Keeper-internal only, never touched by the site - Hunter Bot's "Auto
 * Full" exit mode writes here when its periodic AI re-judgment decides an
 * open position should be sold now (see hunter.ts's reviewFullModePositions
 * and ai.ts's assessExit). positions.ts's tick() reads this the same way it
 * reads the site's manual close-requests, treating a row here as an
 * immediate forced exit - the mandatory stop-loss is still the safety net,
 * this is just an earlier, judgment-based exit on top of it.
 */
export const aiExitRequests = {
  request(positionId: number, reason: string): void {
    db.prepare(`INSERT OR REPLACE INTO ai_exit_requests(position_id,ts,reason) VALUES(?,?,?)`)
      .run(positionId, Math.floor(Date.now() / 1000), reason);
  },
  pendingIds(): Set<number> {
    const rows = db.prepare("SELECT position_id FROM ai_exit_requests").all() as { position_id: number }[];
    return new Set(rows.map((r) => r.position_id));
  },
  clear(positionId: number): void {
    db.prepare("DELETE FROM ai_exit_requests WHERE position_id=?").run(positionId);
  },
};

export const watched = {
  add(token: string, symbol: string, decimals: number, pair: string): void {
    db.prepare(`INSERT OR IGNORE INTO watched(token,symbol,decimals,pair,first_seen)
                VALUES(?,?,?,?,?)`).run(token.toLowerCase(), symbol, decimals, pair.toLowerCase(), Math.floor(Date.now() / 1000));
  },
  all(): { token: string; symbol: string; decimals: number; pair: string }[] {
    return db.prepare("SELECT token,symbol,decimals,pair FROM watched").all() as any;
  },
};

export interface NewOpportunity {
  token: string; priceMovePct: number; liqGrowthPct: number; liqPls: number;
  buyTaxBps: number | null; sellTaxBps: number | null; lpLockedPct: number | null;
  ownerRenounced: boolean | null; sellable: boolean; verdict: string; reason: string; narrative: string;
  // Hunter Bot fields - all optional so discovery.ts's existing calls (a
  // breakout/liquidity-growth anomaly, no technical setup or AI opinion
  // involved) need no changes. "discovery" is the default source.
  source?: "discovery" | "hunter";
  rsi?: number | null;
  macdHistogram?: number | null;
  bollingerPercentB?: number | null;
  aiRecommend?: boolean | null;
  aiConfidence?: "low" | "medium" | "high" | null;
  aiReasoning?: string | null;
  /** How much of Hunter Bot's per-trade ceiling the AI actually wants to
   * spend - see ai.ts's assess()/AiVerdict.suggestedAmountPls. Used both
   * for the initial autoBuy and for a later manual "Buy Now" on the same
   * opportunity, so a human approving it spends what the AI sized, not the
   * full ceiling by default. */
  aiSuggestedAmountPls?: number | null;
}
export interface OpportunityRow extends NewOpportunity { id: number; ts: number; source: "discovery" | "hunter" }

/** Discovery Bot's and Hunter Bot's findings share one feed - one row per
 * candidate either detector found AND ran the full honeypot/tax/lock/
 * renounce screen against (screened once, shared across every vault
 * interested in it - see keeper/src/discovery.ts and keeper/src/hunter.ts).
 * `source` distinguishes which detector produced a row; everything else
 * (the site's Opportunities panel, the manual buy-request flow) is shared. */
export const opportunities = {
  insert(o: NewOpportunity): number {
    const info = db.prepare(`INSERT INTO opportunities
      (token,ts,price_move_pct,liq_growth_pct,liq_pls,buy_tax_bps,sell_tax_bps,lp_locked_pct,owner_renounced,sellable,verdict,reason,narrative,source,rsi,macd_histogram,bollinger_percent_b,ai_recommend,ai_confidence,ai_reasoning,ai_suggested_amount_pls)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      o.token.toLowerCase(), Math.floor(Date.now() / 1000), o.priceMovePct, o.liqGrowthPct, o.liqPls,
      o.buyTaxBps, o.sellTaxBps, o.lpLockedPct, o.ownerRenounced === null ? null : (o.ownerRenounced ? 1 : 0),
      o.sellable ? 1 : 0, o.verdict, o.reason, o.narrative, o.source ?? "discovery",
      o.rsi ?? null, o.macdHistogram ?? null, o.bollingerPercentB ?? null,
      o.aiRecommend === undefined || o.aiRecommend === null ? null : (o.aiRecommend ? 1 : 0),
      o.aiConfidence ?? null, o.aiReasoning ?? null, o.aiSuggestedAmountPls ?? null,
    );
    return Number(info.lastInsertRowid);
  },
  /** True if this token already got a fresh opportunity row within the
   * cooldown window - the dedup that stops the same anomaly re-flagging
   * every scan pass while it's still ongoing. */
  recentForToken(token: string, sinceTs: number): boolean {
    const r = db.prepare("SELECT 1 FROM opportunities WHERE token=? AND ts>=? LIMIT 1")
      .get(token.toLowerCase(), sinceTs);
    return Boolean(r);
  },
  get(id: number): OpportunityRow | undefined {
    const r = db.prepare(`
      SELECT id, token, ts,
             price_move_pct AS priceMovePct, liq_growth_pct AS liqGrowthPct, liq_pls AS liqPls,
             buy_tax_bps AS buyTaxBps, sell_tax_bps AS sellTaxBps, lp_locked_pct AS lpLockedPct,
             owner_renounced AS ownerRenounced, sellable, verdict, reason, narrative,
             source, rsi, macd_histogram AS macdHistogram, bollinger_percent_b AS bollingerPercentB,
             ai_recommend AS aiRecommend, ai_confidence AS aiConfidence, ai_reasoning AS aiReasoning,
             ai_suggested_amount_pls AS aiSuggestedAmountPls
      FROM opportunities WHERE id=?
    `).get(id) as any;
    if (!r) return undefined;
    return {
      ...r,
      ownerRenounced: r.ownerRenounced === null ? null : Boolean(r.ownerRenounced),
      sellable: Boolean(r.sellable),
      aiRecommend: r.aiRecommend === null ? null : Boolean(r.aiRecommend),
    } as OpportunityRow;
  },
};

/** Per-vault record of what happened with one opportunity - notified,
 * bought, or (not currently used, reserved) skipped. Keyed by
 * (vault, opportunity_id) so the same anomaly is acted on at most once per
 * vault; a genuinely new anomaly later gets its own opportunity row and can
 * be acted on again. */
export const discoveryActions = {
  has(vault: string, opportunityId: number): boolean {
    const r = db.prepare("SELECT 1 FROM discovery_actions WHERE vault=? AND opportunity_id=?")
      .get(vault.toLowerCase(), opportunityId);
    return Boolean(r);
  },
  /** The action already recorded for this (vault, opportunity), if any -
   * "notified" vs "bought" matters to a manual buy request: a token already
   * notified is still buyable, one already bought is not (no double-buy). */
  actionFor(vault: string, opportunityId: number): string | undefined {
    const r = db.prepare("SELECT action FROM discovery_actions WHERE vault=? AND opportunity_id=?")
      .get(vault.toLowerCase(), opportunityId) as { action: string } | undefined;
    return r?.action;
  },
  record(vault: string, opportunityId: number, action: string, txHash?: string): void {
    db.prepare(`INSERT OR REPLACE INTO discovery_actions(vault,opportunity_id,ts,action,tx_hash) VALUES(?,?,?,?,?)`)
      .run(vault.toLowerCase(), opportunityId, Math.floor(Date.now() / 1000), action, txHash ?? null);
  },
};
