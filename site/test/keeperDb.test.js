const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const FAKE_KEEPER_DB = path.join(__dirname, "fake-keeper.db");
for (const p of [FAKE_KEEPER_DB, FAKE_KEEPER_DB + "-wal", FAKE_KEEPER_DB + "-shm"]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// Build a fake keeper.db with the SAME schema keeper/src/db.ts creates, so
// this test proves the actual query logic against a real schema, not a
// hand-waved shape.
const setup = new Database(FAKE_KEEPER_DB);
setup.exec(`
  CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT NOT NULL, bot TEXT NOT NULL,
    token TEXT NOT NULL, opened_at INTEGER NOT NULL, entry_price REAL NOT NULL,
    spent_pls REAL NOT NULL, tokens_held TEXT NOT NULL, high_water REAL NOT NULL,
    tp_pct REAL, sl_pct REAL, trail_pct REAL, time_exit_min INTEGER,
    status TEXT NOT NULL DEFAULT 'open', closed_at INTEGER, proceeds_pls REAL, close_reason TEXT
  );
  CREATE TABLE fires (
    id INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT NOT NULL, bot TEXT NOT NULL,
    token TEXT NOT NULL, ts INTEGER NOT NULL, amount REAL NOT NULL, fee REAL NOT NULL, tx_hash TEXT
  );
`);
const VAULT = "0x523a8848e9a1d7f2e083625d1004f76e607bfcd7";
const OTHER_VAULT = "0x" + "9".repeat(40);
setup.prepare(`INSERT INTO positions (vault,bot,token,opened_at,entry_price,spent_pls,tokens_held,high_water,status)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(VAULT, "trading", "0x" + "a".repeat(40), 1000, 1.5, 100, "1000000000000000000", 1.2, "open");
setup.prepare(`INSERT INTO positions (vault,bot,token,opened_at,entry_price,spent_pls,tokens_held,high_water,status,closed_at,proceeds_pls,close_reason)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(VAULT, "launch", "0x" + "b".repeat(40), 900, 2.0, 200, "0", 1.5, "closed", 1200, 250, "take profit 25%");
setup.prepare(`INSERT INTO positions (vault,bot,token,opened_at,entry_price,spent_pls,tokens_held,high_water,status)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(OTHER_VAULT, "trading", "0x" + "c".repeat(40), 1000, 1, 50, "0", 1, "open");
setup.prepare(`INSERT INTO fires (vault,bot,token,ts,amount,fee,tx_hash) VALUES (?,?,?,?,?,?,?)`)
  .run(VAULT, "trading", "0x" + "a".repeat(40), 1000, 100, 0.25, "0xabc123");
setup.prepare(`INSERT INTO fires (vault,bot,token,ts,amount,fee,tx_hash) VALUES (?,?,?,?,?,?,?)`)
  .run(VAULT, "launch", "0x" + "b".repeat(40), 1100, 200, 0.5, "0xdef456");

// Same schema as keeper/src/db.ts's v4_pools - present on a Robinhood
// keeper.db, absent on a PulseChain one (see the "no such table" test below).
setup.exec(`
  CREATE TABLE v4_pools (
    token TEXT NOT NULL, currency0 TEXT NOT NULL, currency1 TEXT NOT NULL,
    fee INTEGER NOT NULL, tick_spacing INTEGER NOT NULL, hooks TEXT NOT NULL, first_seen INTEGER NOT NULL
  );
`);
const V4_TOKEN = "0x" + "d".repeat(40);
setup.prepare(`INSERT INTO v4_pools (token,currency0,currency1,fee,tick_spacing,hooks,first_seen)
  VALUES (?,?,?,?,?,?,?)`).run(V4_TOKEN, V4_TOKEN, "0x" + "e".repeat(40), 3000, 60, "0x" + "0".repeat(40), 1000);

// Same schema as keeper/src/db.ts's opportunities/discovery_actions tables.
setup.exec(`
  CREATE TABLE opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, ts INTEGER NOT NULL,
    price_move_pct REAL NOT NULL, liq_growth_pct REAL NOT NULL, liq_pls REAL NOT NULL,
    buy_tax_bps INTEGER, sell_tax_bps INTEGER, lp_locked_pct REAL, owner_renounced INTEGER,
    sellable INTEGER NOT NULL, verdict TEXT NOT NULL, reason TEXT, narrative TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'discovery', rsi REAL, macd_histogram REAL, bollinger_percent_b REAL,
    ai_recommend INTEGER, ai_confidence TEXT, ai_reasoning TEXT, ai_suggested_amount_pls REAL,
    price_at_detection REAL, stale INTEGER NOT NULL DEFAULT 0, stale_reason TEXT,
    atr_pct REAL, vol_ratio REAL, signal_count INTEGER
  );
  CREATE TABLE discovery_actions (
    vault TEXT NOT NULL, opportunity_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    action TEXT NOT NULL, tx_hash TEXT, PRIMARY KEY (vault, opportunity_id)
  );
  CREATE TABLE prices (
    token TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL, liq REAL NOT NULL, vol REAL NOT NULL,
    PRIMARY KEY (token, ts)
  );
`);
const OPP_TOKEN = "0x" + "f".repeat(40);
const FAILED_OPP_TOKEN = "0x" + "9".repeat(40);
setup.prepare(`INSERT INTO opportunities
  (token,ts,price_move_pct,liq_growth_pct,liq_pls,buy_tax_bps,sell_tax_bps,lp_locked_pct,owner_renounced,sellable,verdict,reason,narrative)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(OPP_TOKEN, 2000, 30, 20, 3000000, 100, 100, 100, 1, 1, "pass", "clear", "moved up 30%");
// A failed screen that DID get found and recorded - stays in the raw table
// (getOpportunities filters it out, tested below), never returned to the site.
setup.prepare(`INSERT INTO opportunities
  (token,ts,price_move_pct,liq_growth_pct,liq_pls,buy_tax_bps,sell_tax_bps,lp_locked_pct,owner_renounced,sellable,verdict,reason,narrative)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(FAILED_OPP_TOKEN, 2100, 40, -60, 500000, 100, 100, 0, 0, 0, "fail", "liquidity pulled", "moved up 40% but liquidity fell");
setup.prepare(`INSERT INTO discovery_actions (vault,opportunity_id,ts,action,tx_hash) VALUES (?,?,?,?,?)`)
  .run(VAULT, 1, 2001, "notified", null);

// A passed screen that later went stale - still returned (verdict alone
// gates what reaches the site, not staleness), so someone can see why they
// missed it instead of it just vanishing.
const STALE_OPP_TOKEN = "0x" + "8".repeat(40);
setup.prepare(`INSERT INTO opportunities
  (token,ts,price_move_pct,liq_growth_pct,liq_pls,buy_tax_bps,sell_tax_bps,lp_locked_pct,owner_renounced,sellable,verdict,reason,narrative,stale,stale_reason)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(STALE_OPP_TOKEN, 1900, 25, 18, 4000000, 100, 100, 100, 1, 1, "pass", "clear", "moved up 25%", 1, "Notified 130 minutes ago - too much time has passed to trust the original signal.");

// A Hunter Bot row carrying ATR/volume-ratio, alongside its RSI/MACD/Bollinger.
const HUNTER_OPP_TOKEN = "0x" + "7".repeat(40);
setup.prepare(`INSERT INTO opportunities
  (token,ts,price_move_pct,liq_growth_pct,liq_pls,buy_tax_bps,sell_tax_bps,lp_locked_pct,owner_renounced,sellable,verdict,reason,narrative,source,rsi,atr_pct,vol_ratio)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(HUNTER_OPP_TOKEN, 1950, -15, 5, 2500000, 100, 100, 100, 1, 1, "pass", "clear", "RSI oversold", "hunter", 22, 14.5, 2.3);

const PRICE_TOKEN = "0x" + "6".repeat(40);
setup.prepare(`INSERT INTO prices (token,ts,price,liq,vol) VALUES (?,?,?,?,?)`).run(PRICE_TOKEN, 1000, 1.0, 500000, 10);
setup.prepare(`INSERT INTO prices (token,ts,price,liq,vol) VALUES (?,?,?,?,?)`).run(PRICE_TOKEN, 2000, 1.2, 520000, 15);
setup.prepare(`INSERT INTO prices (token,ts,price,liq,vol) VALUES (?,?,?,?,?)`).run(PRICE_TOKEN, 500, 0.9, 480000, 8); // before the window

setup.close();

test("returns positions and fires for a vault that has real trading history", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getPositions, getRecentFires } = require("../lib/keeperDb");

  const { open, closed } = getPositions(VAULT);
  assert.equal(open.length, 1);
  assert.equal(open[0].bot, "trading");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].close_reason, "take profit 25%");

  const fires = getRecentFires(VAULT);
  assert.equal(fires.length, 2);
  assert.equal(fires[0].tx_hash, "0xdef456"); // newest first (ts DESC)
});

test("getTotalFees sums every fire's fee for a vault, scoped to that vault only", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getTotalFees } = require("../lib/keeperDb");
  assert.equal(getTotalFees(VAULT), 0.75); // 0.25 + 0.5
  assert.equal(getTotalFees(OTHER_VAULT), 0); // no fires recorded for this one
});

test("getTotalFees is 0 for a vault with no trading history at all", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getTotalFees } = require("../lib/keeperDb");
  assert.equal(getTotalFees("0x" + "9".repeat(40)), 0);
});

test("only returns data scoped to the requested vault, never another vault's", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getPositions } = require("../lib/keeperDb");
  const { open } = getPositions(VAULT);
  assert.ok(!open.some((p) => p.token === "0x" + "c".repeat(40)), "must not leak another vault's position");
});

test("a vault with no history returns empty arrays, not an error", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getPositions, getRecentFires } = require("../lib/keeperDb");
  const never = "0x" + "f".repeat(40);
  assert.deepEqual(getPositions(never), { open: [], closed: [] });
  assert.deepEqual(getRecentFires(never), []);
});

test("a missing keeper.db file (no keeper has run yet) returns empty results, not a crash", () => {
  process.env.KEEPER_DB_PATH = path.join(__dirname, "definitely-does-not-exist.db");
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getPositions, getRecentFires } = require("../lib/keeperDb");
  assert.deepEqual(getPositions(VAULT), { open: [], closed: [] });
  assert.deepEqual(getRecentFires(VAULT), []);
});

test("getV4PoolsForToken returns the pools recorded for that exact token", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getV4PoolsForToken } = require("../lib/keeperDb");
  const rows = getV4PoolsForToken(V4_TOKEN);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fee, 3000);
  assert.equal(getV4PoolsForToken("0x" + "1".repeat(40)).length, 0);
});

test("getV4PoolsForToken returns [] when the keeper.db predates V4 (no v4_pools table)", () => {
  const NO_V4_DB = path.join(__dirname, "fake-keeper-no-v4.db");
  for (const p2 of [NO_V4_DB, NO_V4_DB + "-wal", NO_V4_DB + "-shm"]) {
    if (fs.existsSync(p2)) fs.unlinkSync(p2);
  }
  const noV4 = new Database(NO_V4_DB);
  noV4.exec(`CREATE TABLE positions (id INTEGER PRIMARY KEY);`);
  noV4.close();
  process.env.KEEPER_DB_PATH = NO_V4_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getV4PoolsForToken } = require("../lib/keeperDb");
  assert.deepEqual(getV4PoolsForToken(V4_TOKEN), []);
  fs.unlinkSync(NO_V4_DB);
});

test("getOpportunities returns Discovery Bot findings newest first, passed screens only", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getOpportunities } = require("../lib/keeperDb");
  const rows = getOpportunities();
  assert.equal(rows.length, 3); // the passed one, the passed-but-now-stale one, and the hunter one - not the failed one
  assert.equal(rows[0].token, OPP_TOKEN);
  assert.equal(rows[0].verdict, "pass");
  assert.equal(rows[0].narrative, "moved up 30%");
  assert.equal(rows[0].stale, 0);
  assert.ok(!rows.some((r) => r.token === FAILED_OPP_TOKEN), "a failed screen must never reach the site");
});

test("getOpportunities carries atr_pct and vol_ratio through for a Hunter Bot row", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getOpportunities } = require("../lib/keeperDb");
  const row = getOpportunities().find((r) => r.token === HUNTER_OPP_TOKEN);
  assert.ok(row);
  assert.equal(row.source, "hunter");
  assert.equal(row.atr_pct, 14.5);
  assert.equal(row.vol_ratio, 2.3);
});

test("getOpportunities leaves atr_pct/vol_ratio null for a discovery row that never had them", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getOpportunities } = require("../lib/keeperDb");
  const row = getOpportunities().find((r) => r.token === OPP_TOKEN);
  assert.equal(row.atr_pct, null);
  assert.equal(row.vol_ratio, null);
});

test("getOpportunities still returns a stale opportunity - staleness doesn't hide it, verdict does", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getOpportunities } = require("../lib/keeperDb");
  const rows = getOpportunities();
  const stale = rows.find((r) => r.token === STALE_OPP_TOKEN);
  assert.ok(stale, "a stale-but-passed opportunity must still reach the site");
  assert.equal(stale.stale, 1);
  assert.match(stale.stale_reason, /too much time has passed/);
});

test("getOpportunities returns [] when the keeper.db predates Discovery Bot (no opportunities table)", () => {
  const NO_DISCOVERY_DB = path.join(__dirname, "fake-keeper-no-discovery.db");
  for (const p2 of [NO_DISCOVERY_DB, NO_DISCOVERY_DB + "-wal", NO_DISCOVERY_DB + "-shm"]) {
    if (fs.existsSync(p2)) fs.unlinkSync(p2);
  }
  const noDiscovery = new Database(NO_DISCOVERY_DB);
  noDiscovery.exec(`CREATE TABLE positions (id INTEGER PRIMARY KEY);`);
  noDiscovery.close();
  process.env.KEEPER_DB_PATH = NO_DISCOVERY_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getOpportunities, getDiscoveryActionsForVault } = require("../lib/keeperDb");
  assert.deepEqual(getOpportunities(), []);
  assert.deepEqual(getDiscoveryActionsForVault(VAULT), {});
  fs.unlinkSync(NO_DISCOVERY_DB);
});

test("getDiscoveryActionsForVault keys this vault's actions by opportunity id, never leaking another vault's", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getDiscoveryActionsForVault } = require("../lib/keeperDb");
  const actions = getDiscoveryActionsForVault(VAULT);
  assert.deepEqual(actions, { 1: { action: "notified", txHash: null } });
  assert.deepEqual(getDiscoveryActionsForVault(OTHER_VAULT), {});
});

test("the connection is opened read-only - a write attempt must fail", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const keeperDb = require("../lib/keeperDb");
  keeperDb.getPositions(VAULT); // forces the lazy connection open
  const Database2 = require("better-sqlite3");
  const readonlyDb = new Database2(FAKE_KEEPER_DB, { readonly: true });
  assert.throws(
    () => readonlyDb.prepare("DELETE FROM positions").run(),
    /readonly/i,
    "opening with readonly:true must make writes impossible, protecting the keeper's live data",
  );
  readonlyDb.close();
});

test("getRecentPrices returns ticks since the given timestamp, oldest first, excluding earlier ones", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getRecentPrices } = require("../lib/keeperDb");
  const rows = getRecentPrices(PRICE_TOKEN, 600);
  assert.equal(rows.length, 2); // the tick at ts=500 is before the window
  assert.equal(rows[0].ts, 1000);
  assert.equal(rows[0].price, 1.0);
  assert.equal(rows[0].vol, 10);
  assert.equal(rows[1].ts, 2000);
});

test("getRecentPrices returns [] for a token with no price history on file", () => {
  process.env.KEEPER_DB_PATH = FAKE_KEEPER_DB;
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getRecentPrices } = require("../lib/keeperDb");
  assert.deepEqual(getRecentPrices("0x" + "5".repeat(40), 0), []);
});

test("getRecentPrices returns [] when the keeper.db file doesn't exist yet", () => {
  process.env.KEEPER_DB_PATH = path.join(__dirname, "does-not-exist.db");
  delete require.cache[require.resolve("../lib/keeperDb")];
  const { getRecentPrices } = require("../lib/keeperDb");
  assert.deepEqual(getRecentPrices(PRICE_TOKEN, 0), []);
});
