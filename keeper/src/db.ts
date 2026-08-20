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

CREATE TABLE IF NOT EXISTS v4_pools (
  token        TEXT NOT NULL,
  currency0    TEXT NOT NULL,
  currency1    TEXT NOT NULL,
  fee          INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks        TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  PRIMARY KEY (token, currency0, currency1, fee, tick_spacing, hooks)
);
CREATE INDEX IF NOT EXISTS v4_pools_token ON v4_pools(token);

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
`);

// Additive migration: databases created before the retry-storm fix predate
// this column. SQLite has no ALTER TABLE IF NOT EXISTS, so probe first.
{
  const cols = db.prepare("PRAGMA table_info(positions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "fail_count")) {
    db.exec("ALTER TABLE positions ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0");
  }
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

export interface V4PoolRow {
  token: string; currency0: string; currency1: string;
  fee: number; tick_spacing: number; hooks: string;
}

/**
 * Every V4 pool the scanner has seen for a token, keyed by its full PoolKey.
 * Unlike V2 pairs and V3 pools there is no on-chain lookup to rediscover a
 * V4 pool from a token address alone - the PoolKey (both currencies, fee,
 * tickSpacing, hooks) IS the pool's identity, so it must be recorded at
 * Initialize time or the pool is effectively invisible later. Persisted so
 * a keeper restart doesn't orphan open V4 positions.
 */
export const v4Pools = {
  add(token: string, currency0: string, currency1: string, fee: number, tickSpacing: number, hooks: string): void {
    db.prepare(`INSERT OR IGNORE INTO v4_pools(token,currency0,currency1,fee,tick_spacing,hooks,first_seen)
                VALUES(?,?,?,?,?,?,?)`)
      .run(token.toLowerCase(), currency0.toLowerCase(), currency1.toLowerCase(),
           fee, tickSpacing, hooks.toLowerCase(), Math.floor(Date.now() / 1000));
  },
  forToken(token: string): V4PoolRow[] {
    return db.prepare("SELECT token,currency0,currency1,fee,tick_spacing,hooks FROM v4_pools WHERE token=?")
      .all(token.toLowerCase()) as V4PoolRow[];
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
}
export interface OpportunityRow extends NewOpportunity { id: number; ts: number }

/** Discovery Bot's findings - one row per anomaly the scanner both detected
 * AND ran the full honeypot/tax/lock/renounce screen against (screened once,
 * shared across every vault interested in it - see keeper/src/discovery.ts). */
export const opportunities = {
  insert(o: NewOpportunity): number {
    const info = db.prepare(`INSERT INTO opportunities
      (token,ts,price_move_pct,liq_growth_pct,liq_pls,buy_tax_bps,sell_tax_bps,lp_locked_pct,owner_renounced,sellable,verdict,reason,narrative)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      o.token.toLowerCase(), Math.floor(Date.now() / 1000), o.priceMovePct, o.liqGrowthPct, o.liqPls,
      o.buyTaxBps, o.sellTaxBps, o.lpLockedPct, o.ownerRenounced === null ? null : (o.ownerRenounced ? 1 : 0),
      o.sellable ? 1 : 0, o.verdict, o.reason, o.narrative,
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
    return db.prepare("SELECT * FROM opportunities WHERE id=?").get(id) as OpportunityRow | undefined;
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
