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

-- Drains into a price tick's vol/trades columns each poll, then resets to 0 -
-- see prices.ts's scanSwapVolume/pollAll. A running total between polls, not
-- a history of its own. trades is a plain count of matched Swap events -
-- how many separate trades happened, independent of their size - see
-- hunter.ts's minTrades24h: a token can show real PLS volume off one whale
-- trade while otherwise dead, or modest volume while genuinely trading
-- often: trade count, not $ volume, is what answers "is this actually being
-- traded" without needing a per-token-scale dollar guess.
-- buy_vol/sell_vol/buy_trades/sell_trades split the same totals by which
-- side of the swap WPLS was on (WPLS in = a buy, WPLS out = a sell) - see
-- prices.ts's scanSwapVolume. Added for Hunter Bot's order-flow signals
-- (buy/sell pressure, new-buyer growth), which need to know which direction
-- a trade went, not just that a trade happened - vol/trades above stay
-- undirected sums for everything that only ever needed total activity.
CREATE TABLE IF NOT EXISTS token_volume_accum (
  token       TEXT PRIMARY KEY,
  vol         REAL NOT NULL DEFAULT 0,
  trades      INTEGER NOT NULL DEFAULT 0,
  buy_vol     REAL NOT NULL DEFAULT 0,
  sell_vol    REAL NOT NULL DEFAULT 0,
  buy_trades  INTEGER NOT NULL DEFAULT 0,
  sell_trades INTEGER NOT NULL DEFAULT 0
);

-- One row per matched Swap event's real trader wallet (the swap's "to"
-- address - see prices.ts's scanSwapVolume) - free to collect, since it's
-- the same log already being fetched and parsed for volume/trade-count, no
-- extra RPC cost. Answers a different question than trades: minTrades24h
-- (token_volume_accum -> prices.trades) counts separate SWAPS, which one
-- wallet trading with itself 30 times satisfies just as easily as 30 real
-- buyers each trading once - COUNT(DISTINCT address) here can't be faked
-- that way. Rows are NOT deduped at insert time (the same wallet trading
-- twice in a window just adds two rows) - correctness only needs
-- COUNT(DISTINCT address) over a window, not a unique-row guarantee, and a
-- day or two of rows for even a hyperactive token is cheap. Kept to a short
-- window (see prune below) - unlike prices (45 days, real indicator
-- lookback), nothing here needs history older than the 24h/48h windows
-- that actually read it.
-- side ('buy'|'sell'), added alongside token_volume_accum's split above -
-- lets count() answer "how many DIFFERENT wallets BOUGHT" separately from
-- "how many traded at all", which is what a new-buyer-growth signal needs.
-- NULL on any row recorded before this column existed - those still count
-- toward an undirected count() call, just never toward a side-filtered one.
CREATE TABLE IF NOT EXISTS token_traders (
  token   TEXT NOT NULL,
  address TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  side    TEXT
);
CREATE INDEX IF NOT EXISTS token_traders_token_ts ON token_traders(token, ts DESC);

CREATE TABLE IF NOT EXISTS watched (
  token      TEXT PRIMARY KEY,
  symbol     TEXT,
  decimals   INTEGER DEFAULT 18,
  pair       TEXT,
  first_seen INTEGER NOT NULL,
  -- Whether WPLS is token0 of the pair, resolved once at watch time. NULL on
  -- a row from before this existed - readPair()/scanSwapVolume() in
  -- prices.ts self-heal it lazily on first use, not a bulk backfill.
  pls_first  INTEGER
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
  tx_hash  TEXT,
  side     TEXT
);
CREATE INDEX IF NOT EXISTS fires_vault_ts ON fires(vault, ts DESC);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Which PulseX factory pair indices are a WPLS pair, and which side WPLS is
-- on. A pair's token0/token1 never change once created, so this is a
-- permanent classification - see marketSeed.ts. Lets a repeat market-seed
-- pass skip the token0/token1 lookup entirely for every already-classified
-- index and only re-check the (much smaller) known-WPLS set's liquidity.
CREATE TABLE IF NOT EXISTS wpls_pairs (
  idx       INTEGER PRIMARY KEY,
  pair      TEXT NOT NULL,
  token     TEXT NOT NULL,
  pls_first INTEGER NOT NULL
);

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

-- Hunter IQ: what a vault's Hunter Bot has learned, from three sources -
-- 'owner' (the vault owner typed guidance on the dashboard), 'self_loss'
-- (the bot reflected on one of its own losing closes), 'self_miss' (the bot
-- reflected on a token it declined that then ran without it). See hunter.ts's
-- personalizedAssess/reflectOnClosedLosses/reflectOnMissedOpportunities.
-- position_id/opportunity_id are set only for the source they came from,
-- and double as a dedup key - a given closed position or declined
-- opportunity only ever generates one self-written lesson, never one per
-- tick it happens to still match the query.
CREATE TABLE IF NOT EXISTS hunter_lessons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vault           TEXT NOT NULL,
  source          TEXT NOT NULL, -- 'owner' | 'self_loss' | 'self_miss'
  text            TEXT NOT NULL,
  position_id     INTEGER,
  opportunity_id  INTEGER,
  owner_request_id INTEGER, -- site.db's hunter_feedback_requests.id, for 'owner' rows - dedups re-ingesting the same request every tick
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hunter_lessons_vault_ts ON hunter_lessons(vault, ts DESC);

-- Every closed Hunter position / declined Hunter opportunity this vault's
-- bot has already reviewed for a self-written lesson, whether or not the
-- review actually produced one (most closes are small wins or near-flat -
-- nothing to reflect on). Separate from hunter_lessons itself so the
-- reflect-on-* scans below can move on permanently after one look, instead
-- of re-querying every non-lesson-worthy close/decline on every tick
-- forever.
CREATE TABLE IF NOT EXISTS hunter_reviewed_closes (position_id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS hunter_reviewed_misses (opportunity_id INTEGER PRIMARY KEY);

-- A resting rebuy the keeper created for itself after closing a Hunter
-- position on a bearish/profit-taking read - see hunter.ts's
-- considerAutoRebuys/checkPendingRebuys. Deliberately NOT part of the
-- owner's signed limitOrders config (registry.ts's LimitOrder) - the
-- keeper can never write into that (only the vault owner's own signature
-- can), so this is its own keeper-internal table instead, gated by the
-- owner's one signed autoRebuyOnExit toggle rather than a per-order
-- signature. Deleted on fire or on expiry either way, never left around.
CREATE TABLE IF NOT EXISTS hunter_pending_rebuys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vault         TEXT NOT NULL,
  token         TEXT NOT NULL,
  target_price  REAL NOT NULL,
  amount_pls    REAL NOT NULL,
  source_position_id INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hunter_pending_rebuys_vault ON hunter_pending_rebuys(vault);

-- Every closed Hunter position already considered for an auto-rebuy,
-- whether or not it actually qualified - same "look once, move on
-- permanently" shape as hunter_reviewed_closes above, kept separate since
-- it tracks a different question (was a rebuy created?) on the same
-- underlying closes.
CREATE TABLE IF NOT EXISTS hunter_rebuy_considered (position_id INTEGER PRIMARY KEY);
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
  // The exact transaction that created this position, when known - traces a
  // position back to real on-chain proof instead of just this row's own
  // say-so, and lets a one-time backfill script (scripts/backfill-limit-
  // positions.js, for the bug where a filled limit-order buy never created a
  // position at all) check whether a given fill has already been backfilled
  // without guessing from timing alone. NULL for anything opened before this
  // column existed.
  if (!cols.some((c) => c.name === "source_tx_hash")) {
    db.exec("ALTER TABLE positions ADD COLUMN source_tx_hash TEXT");
  }
  // Last time Auto Full's AI exit judgment actually reviewed this position -
  // see hunter.ts's MIN_REVIEW_GAP_MINUTES. NULL until the first review.
  if (!cols.some((c) => c.name === "last_ai_review_at")) {
    db.exec("ALTER TABLE positions ADD COLUMN last_ai_review_at INTEGER");
  }
  // Set when Auto Full's AI recommends selling a position that is currently
  // at a net loss, and cleared the moment it isn't (a hold verdict, or the
  // position turning green) - see hunter.ts's reviewFullModePositions. A
  // loss-side sell verdict is only actually acted on the second time it
  // comes back in a row, so one AI review reading a temporary dip as a
  // "breakdown" can't lock in a loss on its own; a real breakdown still
  // reads the same way on the next review and goes through. Profit-side
  // sells never touch this - taking a genuine gain always executes
  // immediately, same as before.
  if (!cols.some((c) => c.name === "loss_sell_pending")) {
    db.exec("ALTER TABLE positions ADD COLUMN loss_sell_pending INTEGER NOT NULL DEFAULT 0");
  }
  // Stamped every time retryStuckPositions actually checks a stuck position,
  // whether or not the check finds anything sellable - the dashboard shows
  // this as "last checked" on Stuck Positions so it's visible proof the
  // sweep is still alive and retrying, not silently giving up. NULL until a
  // stuck position's first retry pass.
  if (!cols.some((c) => c.name === "last_retry_at")) {
    db.exec("ALTER TABLE positions ADD COLUMN last_retry_at INTEGER");
  }
  // Tiered trailing stop (see portfolio.ts's sellSignal) - Hunter Bot only,
  // NULL for every other bot. tight_trail_pct is the trail distance used
  // while the peak gain is still under trail_widen_at_pct (locks in a quick
  // win fast if momentum stalls early); trail_pct becomes the effective
  // trail once the peak passes that threshold (gives a real move room to
  // keep running toward a bigger exit).
  if (!cols.some((c) => c.name === "tight_trail_pct")) {
    db.exec("ALTER TABLE positions ADD COLUMN tight_trail_pct REAL");
  }
  if (!cols.some((c) => c.name === "trail_widen_at_pct")) {
    db.exec("ALTER TABLE positions ADD COLUMN trail_widen_at_pct REAL");
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
  add("price_at_detection", "price_at_detection REAL");
  add("stale", "stale INTEGER NOT NULL DEFAULT 0");
  add("stale_reason", "stale_reason TEXT");
  // ATR (volatility, as a % of price) and volume confirmation ratio - see
  // indicators.ts's atr()/volumeConfirmation(). Both null for discovery.ts's
  // rows (no technical setup involved there) and for any hunter.ts row from
  // before these existed.
  add("atr_pct", "atr_pct REAL");
  add("vol_ratio", "vol_ratio REAL");
  // How many of Hunter Bot's requirements actually fired together - see
  // hunter.ts's checkSignals/evaluateWatchedToken. Null for discovery.ts's
  // rows, which has no signal set of its own.
  add("signal_count", "signal_count INTEGER");
  // Hunter Bot's order-flow/liquidity-flow/participation/structure signals -
  // see indicators.ts's orderFlow/liquidityTrend/donchianBreakout and
  // hunter.ts's checkSignals. Replaced rsi/macd_histogram/bollinger_percent_b
  // above as Hunter's detection basis (those three still exist and are still
  // written null-safe for any old row, but no longer populated - RSI/MACD/
  // Bollinger are all derived from price alone, so requiring several of them
  // to agree wasn't real diversification; these four measure genuinely
  // different things - real trade direction, real capital committing, real
  // new participants, real price structure - not just price restated).
  add("buy_ratio", "buy_ratio REAL");
  add("liq_trend_pct", "liq_trend_pct REAL");
  add("new_buyers", "new_buyers INTEGER");
  add("broke_out", "broke_out INTEGER");
}

// Additive migration: databases created before volume tracking existed have
// no vol column on prices - old rows read back as 0 (see PricePoint below),
// same "missing means zero, not unknown" convention token_volume_accum uses.
{
  const cols = db.prepare("PRAGMA table_info(prices)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "vol")) {
    db.exec("ALTER TABLE prices ADD COLUMN vol REAL NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "trades")) {
    db.exec("ALTER TABLE prices ADD COLUMN trades INTEGER NOT NULL DEFAULT 0");
  }
  // Directional split for Hunter Bot's order-flow signals - see
  // token_volume_accum's own comment. Old rows read back as 0 on both
  // sides, same convention as vol/trades above; a signal reading history
  // that predates this migration just sees no buy/sell data there; it
  // never sees a false ratio, since 0/0 is treated as "no data" (see
  // indicators.ts's orderFlow), not as a real 0% buy ratio.
  for (const col of ["buy_vol", "sell_vol"]) {
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE prices ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  }
  for (const col of ["buy_trades", "sell_trades"]) {
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE prices ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
}

// Additive migration: same reasoning, for token_volume_accum's trades and
// buy/sell split columns - trades added alongside the minTrades24h liveness
// check, buy/sell added alongside Hunter Bot's order-flow signals.
{
  const cols = db.prepare("PRAGMA table_info(token_volume_accum)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "trades")) {
    db.exec("ALTER TABLE token_volume_accum ADD COLUMN trades INTEGER NOT NULL DEFAULT 0");
  }
  for (const col of ["buy_vol", "sell_vol"]) {
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE token_volume_accum ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  }
  for (const col of ["buy_trades", "sell_trades"]) {
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE token_volume_accum ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
}

// Additive migration: token_traders rows from before the buy/sell split
// existed have no side - self-heals the same way as everywhere else here,
// nothing backfills it.
{
  const cols = db.prepare("PRAGMA table_info(token_traders)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "side")) {
    db.exec("ALTER TABLE token_traders ADD COLUMN side TEXT");
  }
}

// Additive migration: a watched row from before pls_first existed reads
// back as NULL - prices.ts resolves and persists it on first use rather
// than needing a bulk backfill.
{
  const cols = db.prepare("PRAGMA table_info(watched)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "pls_first")) {
    db.exec("ALTER TABLE watched ADD COLUMN pls_first INTEGER");
  }
}

// Additive migration: Recent Trades on the dashboard had no way to show
// buy vs sell - executor.ts always knew (WPLS-in means buy, token-in means
// sell), it just never persisted it. NULL on any row fired before this
// column existed; the site shows those as unlabeled rather than guessing.
{
  const cols = db.prepare("PRAGMA table_info(fires)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "side")) {
    db.exec("ALTER TABLE fires ADD COLUMN side TEXT");
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

export interface WplsPairRow { idx: number; pair: string; token: string; plsFirst: boolean }

export const wplsPairs = {
  insert(idx: number, pair: string, token: string, plsFirst: boolean): void {
    db.prepare("INSERT OR REPLACE INTO wpls_pairs(idx,pair,token,pls_first) VALUES(?,?,?,?)")
      .run(idx, pair.toLowerCase(), token.toLowerCase(), plsFirst ? 1 : 0);
  },
  all(): WplsPairRow[] {
    return (db.prepare("SELECT idx, pair, token, pls_first FROM wpls_pairs").all() as
      { idx: number; pair: string; token: string; pls_first: number }[])
      .map((r) => ({ idx: r.idx, pair: r.pair, token: r.token, plsFirst: r.pls_first === 1 }));
  },
};

export interface PricePoint {
  ts: number; price: number; liq: number; vol: number; trades: number;
  buyVol: number; sellVol: number; buyTrades: number; sellTrades: number;
}

export const prices = {
  insert: db.prepare(`INSERT OR REPLACE INTO prices
    (token,ts,price,liq,vol,trades,buy_vol,sell_vol,buy_trades,sell_trades) VALUES(?,?,?,?,?,?,?,?,?,?)`),

  since(token: string, fromTs: number): PricePoint[] {
    return (db.prepare(`SELECT ts,price,liq,vol,trades,
        buy_vol AS buyVol, sell_vol AS sellVol, buy_trades AS buyTrades, sell_trades AS sellTrades
      FROM prices WHERE token=? AND ts>=? ORDER BY ts ASC`)
      .all(token.toLowerCase(), fromTs)) as PricePoint[];
  },
  latest(token: string): PricePoint | undefined {
    return (db.prepare(`SELECT ts,price,liq,vol,trades,
        buy_vol AS buyVol, sell_vol AS sellVol, buy_trades AS buyTrades, sell_trades AS sellTrades
      FROM prices WHERE token=? ORDER BY ts DESC LIMIT 1`)
      .get(token.toLowerCase())) as PricePoint | undefined;
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
 * Running WPLS-denominated Swap volume AND trade count per token,
 * accumulated as prices.ts's scanSwapVolume() scans chain logs (one add()
 * call per matched Swap event, so trades is just a count of how many calls
 * happened), then drained into that interval's prices.vol/trades on the
 * next poll and reset to 0 - see pollAll(). Decouples the block-based log
 * scan from the price-poll cadence: either can run more or less often than
 * the other without losing or double-counting volume, since a swap always
 * lands in exactly one drain no matter when it's scanned relative to the
 * poll tick.
 *
 * buy/sell split added for Hunter Bot's order-flow signals - a swap moving
 * WPLS INTO the pair is someone buying the token; WPLS OUT is someone
 * selling it (see prices.ts's scanSwapVolume, which now classifies each
 * swap by direction before calling add()).
 */
export const volumeAccum = {
  add(token: string, wplsAmount: number, side: "buy" | "sell"): void {
    const buyVol = side === "buy" ? wplsAmount : 0;
    const sellVol = side === "sell" ? wplsAmount : 0;
    const buyTrades = side === "buy" ? 1 : 0;
    const sellTrades = side === "sell" ? 1 : 0;
    db.prepare(`INSERT INTO token_volume_accum(token,vol,trades,buy_vol,sell_vol,buy_trades,sell_trades)
                VALUES(?,?,1,?,?,?,?)
                ON CONFLICT(token) DO UPDATE SET
                  vol = vol + excluded.vol, trades = trades + 1,
                  buy_vol = buy_vol + excluded.buy_vol, sell_vol = sell_vol + excluded.sell_vol,
                  buy_trades = buy_trades + excluded.buy_trades, sell_trades = sell_trades + excluded.sell_trades`)
      .run(token.toLowerCase(), wplsAmount, buyVol, sellVol, buyTrades, sellTrades);
  },
  /** Reads the current totals and resets them to 0 in the same call -
   * callers must persist the returned values themselves (see pollAll()),
   * since once drained they're gone from the accumulator either way. */
  drain(token: string): { vol: number; trades: number; buyVol: number; sellVol: number; buyTrades: number; sellTrades: number } {
    const t = token.toLowerCase();
    const r = db.prepare("SELECT vol, trades, buy_vol AS buyVol, sell_vol AS sellVol, buy_trades AS buyTrades, sell_trades AS sellTrades FROM token_volume_accum WHERE token=?")
      .get(t) as { vol: number; trades: number; buyVol: number; sellVol: number; buyTrades: number; sellTrades: number } | undefined;
    if (r) db.prepare("UPDATE token_volume_accum SET vol=0, trades=0, buy_vol=0, sell_vol=0, buy_trades=0, sell_trades=0 WHERE token=?").run(t);
    return { vol: r?.vol ?? 0, trades: r?.trades ?? 0, buyVol: r?.buyVol ?? 0, sellVol: r?.sellVol ?? 0, buyTrades: r?.buyTrades ?? 0, sellTrades: r?.sellTrades ?? 0 };
  },
};

/**
 * Distinct-wallet trading activity per token - see token_traders' own
 * comment for why this exists alongside trade count rather than instead of
 * it. record() is called once per matched Swap event's real trader wallet
 * (prices.ts's scanSwapVolume); count() answers "how many DIFFERENT
 * wallets traded this token in the last N hours" (hunter.ts's
 * minUniqueTraders24h), optionally narrowed to one side of the trade for
 * Hunter's new-buyer-growth signal; prune() bounds the table to a short
 * rolling window since nothing here reads further back than a day or two.
 */
export const tokenTraders = {
  record(token: string, address: string, ts: number, side: "buy" | "sell"): void {
    db.prepare("INSERT INTO token_traders(token,address,ts,side) VALUES(?,?,?,?)")
      .run(token.toLowerCase(), address.toLowerCase(), ts, side);
  },
  count(token: string, sinceTs: number, side?: "buy" | "sell"): number {
    const r = side
      ? db.prepare("SELECT COUNT(DISTINCT address) n FROM token_traders WHERE token=? AND ts>=? AND side=?")
          .get(token.toLowerCase(), sinceTs, side) as { n: number }
      : db.prepare("SELECT COUNT(DISTINCT address) n FROM token_traders WHERE token=? AND ts>=?")
          .get(token.toLowerCase(), sinceTs) as { n: number };
    return r.n;
  },
  prune(beforeTs: number): void {
    db.prepare("DELETE FROM token_traders WHERE ts<?").run(beforeTs);
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
  add(token: string, symbol: string, decimals: number, pair: string, plsFirst: boolean): void {
    db.prepare(`INSERT OR IGNORE INTO watched(token,symbol,decimals,pair,first_seen,pls_first)
                VALUES(?,?,?,?,?,?)`).run(
      token.toLowerCase(), symbol, decimals, pair.toLowerCase(), Math.floor(Date.now() / 1000), plsFirst ? 1 : 0,
    );
  },
  all(): { token: string; symbol: string; decimals: number; pair: string; plsFirst: boolean | null }[] {
    const rows = db.prepare("SELECT token,symbol,decimals,pair,pls_first AS plsFirst FROM watched").all() as any[];
    return rows.map((r) => ({ ...r, plsFirst: r.plsFirst === null ? null : Boolean(r.plsFirst) }));
  },
  /** Persists a lazily-resolved pls_first for a row that predates the
   * column - see prices.ts's readPair()/scanSwapVolume() self-heal. */
  setPlsFirst(token: string, plsFirst: boolean): void {
    db.prepare("UPDATE watched SET pls_first=? WHERE token=?").run(plsFirst ? 1 : 0, token.toLowerCase());
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
  /** The token's own price at the moment this opportunity was detected -
   * not the move percentage, the actual price - so a later pass can tell
   * whether it has since pulled back toward where it started (see
   * refreshStaleness in discovery.ts). Null is fine (an old row from before
   * this existed); staleness then falls back to the time-based check alone. */
  priceAtDetection?: number | null;
  /** ATR as a % of price at detection time, and the recent-vs-baseline
   * volume ratio (see indicators.ts's atr()/volumeConfirmation()) - stored
   * so a later manual "Buy Now" on this same opportunity can size an
   * ATR-based stop-loss off the same numbers the detection pass saw,
   * without needing a fresh candle read at execution time. Null for
   * discovery.ts's rows (no technical setup there) and for hunter.ts rows
   * predating these fields. */
  atrPct?: number | null;
  volRatio?: number | null;
  /** How many of Hunter Bot's requirements fired together (see hunter.ts's
   * checkSignals) - null for discovery.ts's rows, which have no signal set
   * of its own. */
  signalCount?: number | null;
  /** Hunter Bot's order-flow/liquidity-flow/participation/structure signal
   * readout at detection time - see indicators.ts's orderFlow/
   * liquidityTrend/donchianBreakout. All null for discovery.ts's rows. */
  buyRatio?: number | null;
  liqTrendPct?: number | null;
  newBuyers?: number | null;
  brokeOut?: boolean | null;
}
export interface OpportunityRow extends NewOpportunity {
  id: number; ts: number; source: "discovery" | "hunter";
  stale: boolean; staleReason: string | null;
}

/** Discovery Bot's and Hunter Bot's findings share one feed - one row per
 * candidate either detector found AND ran the full honeypot/tax/lock/
 * renounce screen against (screened once, shared across every vault
 * interested in it - see keeper/src/discovery.ts and keeper/src/hunter.ts).
 * `source` distinguishes which detector produced a row; everything else
 * (the site's Opportunities panel, the manual buy-request flow) is shared. */
export const opportunities = {
  insert(o: NewOpportunity): number {
    const info = db.prepare(`INSERT INTO opportunities
      (token,ts,price_move_pct,liq_growth_pct,liq_pls,buy_tax_bps,sell_tax_bps,lp_locked_pct,owner_renounced,sellable,verdict,reason,narrative,source,rsi,macd_histogram,bollinger_percent_b,ai_recommend,ai_confidence,ai_reasoning,ai_suggested_amount_pls,price_at_detection,atr_pct,vol_ratio,signal_count,buy_ratio,liq_trend_pct,new_buyers,broke_out)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      o.token.toLowerCase(), Math.floor(Date.now() / 1000), o.priceMovePct, o.liqGrowthPct, o.liqPls,
      o.buyTaxBps, o.sellTaxBps, o.lpLockedPct, o.ownerRenounced === null ? null : (o.ownerRenounced ? 1 : 0),
      o.sellable ? 1 : 0, o.verdict, o.reason, o.narrative, o.source ?? "discovery",
      o.rsi ?? null, o.macdHistogram ?? null, o.bollingerPercentB ?? null,
      o.aiRecommend === undefined || o.aiRecommend === null ? null : (o.aiRecommend ? 1 : 0),
      o.aiConfidence ?? null, o.aiReasoning ?? null, o.aiSuggestedAmountPls ?? null,
      o.priceAtDetection ?? null, o.atrPct ?? null, o.volRatio ?? null, o.signalCount ?? null,
      o.buyRatio ?? null, o.liqTrendPct ?? null, o.newBuyers ?? null,
      o.brokeOut === undefined || o.brokeOut === null ? null : (o.brokeOut ? 1 : 0),
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
             ai_suggested_amount_pls AS aiSuggestedAmountPls,
             price_at_detection AS priceAtDetection, stale, stale_reason AS staleReason,
             atr_pct AS atrPct, vol_ratio AS volRatio, signal_count AS signalCount,
             buy_ratio AS buyRatio, liq_trend_pct AS liqTrendPct, new_buyers AS newBuyers, broke_out AS brokeOut
      FROM opportunities WHERE id=?
    `).get(id) as any;
    if (!r) return undefined;
    return {
      ...r,
      ownerRenounced: r.ownerRenounced === null ? null : Boolean(r.ownerRenounced),
      sellable: Boolean(r.sellable),
      aiRecommend: r.aiRecommend === null ? null : Boolean(r.aiRecommend),
      brokeOut: r.brokeOut === null ? null : Boolean(r.brokeOut),
      stale: Boolean(r.stale),
    } as OpportunityRow;
  },
  /** Every notified-but-not-bought opportunity from the last `withinSec`
   * seconds that isn't already marked stale - the working set
   * refreshStaleness() re-checks each tick. Bounded to a recent window on
   * purpose: an opportunity nobody acted on from days ago has long since
   * been superseded by the TTL check anyway, so there's no reason to keep
   * re-querying it forever. */
  notifiedCandidatesForStaleness(withinSec: number): { id: number; token: string; ts: number; source: "discovery" | "hunter"; priceAtDetection: number | null }[] {
    const since = Math.floor(Date.now() / 1000) - withinSec;
    return db.prepare(`
      SELECT DISTINCT o.id, o.token, o.ts, o.source, o.price_at_detection AS priceAtDetection
      FROM opportunities o
      JOIN discovery_actions a ON a.opportunity_id = o.id AND a.action = 'notified'
      WHERE o.ts >= ? AND o.stale = 0
    `).all(since) as any;
  },
  markStale(id: number, reason: string): void {
    db.prepare("UPDATE opportunities SET stale=1, stale_reason=? WHERE id=?").run(reason, id);
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

export type HunterLessonSource = "owner" | "self_loss" | "self_miss";
export interface HunterLessonRow {
  id: number; vault: string; source: HunterLessonSource; text: string;
  positionId: number | null; opportunityId: number | null; ts: number;
}

/** Hunter IQ's memory - every lesson a vault's Hunter Bot has (owner-typed
 * or self-written), newest first when read, and the small "have I already
 * looked at this" trackers that keep the reflect-on-* scans in hunter.ts
 * from re-querying the same closed position or declined opportunity
 * forever. See db.ts's hunter_lessons/hunter_reviewed_closes/
 * hunter_reviewed_misses tables. */
export const hunterLessons = {
  add(vault: string, source: HunterLessonSource, text: string, opts?: { positionId?: number; opportunityId?: number; ownerRequestId?: number }): void {
    db.prepare(`INSERT INTO hunter_lessons(vault,source,text,position_id,opportunity_id,owner_request_id,ts) VALUES(?,?,?,?,?,?,?)`)
      .run(vault.toLowerCase(), source, text, opts?.positionId ?? null, opts?.opportunityId ?? null, opts?.ownerRequestId ?? null, Math.floor(Date.now() / 1000));
  },
  hasAny(vault: string): boolean {
    const r = db.prepare("SELECT 1 FROM hunter_lessons WHERE vault=? LIMIT 1").get(vault.toLowerCase());
    return Boolean(r);
  },
  /** Most recent `limit` lessons, oldest of the batch first - the order an
   * AI prompt should read them in, and a reasonable reading order for the
   * dashboard's own lessons list too. */
  recentForVault(vault: string, limit: number): HunterLessonRow[] {
    const rows = db.prepare(`
      SELECT id, vault, source, text, position_id AS positionId, opportunity_id AS opportunityId, ts
      FROM hunter_lessons WHERE vault=? ORDER BY ts DESC LIMIT ?
    `).all(vault.toLowerCase(), limit) as HunterLessonRow[];
    return rows.reverse();
  },
  alreadyIngestedOwnerRequest(vault: string, ownerRequestId: number): boolean {
    const r = db.prepare("SELECT 1 FROM hunter_lessons WHERE vault=? AND owner_request_id=? LIMIT 1")
      .get(vault.toLowerCase(), ownerRequestId);
    return Boolean(r);
  },
  closeAlreadyReviewed(positionId: number): boolean {
    return Boolean(db.prepare("SELECT 1 FROM hunter_reviewed_closes WHERE position_id=?").get(positionId));
  },
  markCloseReviewed(positionId: number): void {
    db.prepare("INSERT OR IGNORE INTO hunter_reviewed_closes(position_id) VALUES(?)").run(positionId);
  },
  missAlreadyReviewed(opportunityId: number): boolean {
    return Boolean(db.prepare("SELECT 1 FROM hunter_reviewed_misses WHERE opportunity_id=?").get(opportunityId));
  },
  markMissReviewed(opportunityId: number): void {
    db.prepare("INSERT OR IGNORE INTO hunter_reviewed_misses(opportunity_id) VALUES(?)").run(opportunityId);
  },
};

export interface PendingRebuyRow {
  id: number; vault: string; token: string; targetPrice: number; amountPls: number;
  sourcePositionId: number; createdAt: number; expiresAt: number;
}

/** Keeper-internal resting rebuys - see the hunter_pending_rebuys table
 * comment in the schema above for why these live here instead of in the
 * owner's signed limitOrders config. */
export const pendingRebuys = {
  insert(vault: string, token: string, targetPrice: number, amountPls: number, sourcePositionId: number, expiresAt: number): void {
    db.prepare(`INSERT INTO hunter_pending_rebuys(vault,token,target_price,amount_pls,source_position_id,created_at,expires_at)
                VALUES(?,?,?,?,?,?,?)`)
      .run(vault.toLowerCase(), token.toLowerCase(), targetPrice, amountPls, sourcePositionId,
           Math.floor(Date.now() / 1000), expiresAt);
  },
  all(): PendingRebuyRow[] {
    return db.prepare(`
      SELECT id, vault, token, target_price AS targetPrice, amount_pls AS amountPls,
             source_position_id AS sourcePositionId, created_at AS createdAt, expires_at AS expiresAt
      FROM hunter_pending_rebuys
    `).all() as PendingRebuyRow[];
  },
  remove(id: number): void {
    db.prepare("DELETE FROM hunter_pending_rebuys WHERE id=?").run(id);
  },
  rebuyAlreadyConsidered(positionId: number): boolean {
    return Boolean(db.prepare("SELECT 1 FROM hunter_rebuy_considered WHERE position_id=?").get(positionId));
  },
  markRebuyConsidered(positionId: number): void {
    db.prepare("INSERT OR IGNORE INTO hunter_rebuy_considered(position_id) VALUES(?)").run(positionId);
  },
};
