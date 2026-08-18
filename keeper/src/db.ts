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

export const watched = {
  add(token: string, symbol: string, decimals: number, pair: string): void {
    db.prepare(`INSERT OR IGNORE INTO watched(token,symbol,decimals,pair,first_seen)
                VALUES(?,?,?,?,?)`).run(token.toLowerCase(), symbol, decimals, pair.toLowerCase(), Math.floor(Date.now() / 1000));
  },
  all(): { token: string; symbol: string; decimals: number; pair: string }[] {
    return db.prepare("SELECT token,symbol,decimals,pair FROM watched").all() as any;
  },
};
