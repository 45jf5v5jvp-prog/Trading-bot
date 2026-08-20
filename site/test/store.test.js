const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DB_PATH = path.join(__dirname, "store-test.db");
for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
process.env.SITE_DB_PATH = DB_PATH;

const { getConfig, setConfig, requestClose, pendingCloseIds, requestDiscoveryBuy, pendingDiscoveryBuyIds } = require("../lib/store");
const { emptyConfig } = require("../lib/schema");

test("getConfig returns the empty default for a vault never written to", () => {
  const c = getConfig("0x" + "9".repeat(40));
  assert.deepEqual(c, emptyConfig());
});

test("setConfig then getConfig round-trips exactly when every section is present", () => {
  const vault = "0x" + "a".repeat(40);
  const cfg = { ...emptyConfig(),
    launch: { enabled: true, perLaunchPls: 1000, maxPerDay: 4, takeProfitPct: 50,
      stopLossPct: 35, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
      requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: 2000000 },
    rules: [{ enabled: true, token: "0x" + "b".repeat(40), direction: "drops",
      thresholdPct: 10, lookbackHours: 24, allocPct: 20, cooldownHours: 6, maxFires: 3 }],
    maxHoldingPct: 35 };
  setConfig(vault, cfg, Date.now());
  assert.deepEqual(getConfig(vault), cfg);
});

test("vault addresses are case-insensitive (stored lowercase)", () => {
  const lower = "0x" + "c".repeat(40);
  const cfg = { ...emptyConfig(),
    launch: { enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50,
      stopLossPct: 35, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
      requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: 2000000 } };
  setConfig(lower.toUpperCase(), cfg, Date.now());
  assert.deepEqual(getConfig(lower), cfg);
});

test("setConfig overwrites a previous config for the same vault", () => {
  const vault = "0x" + "d".repeat(40);
  const base = { ...emptyConfig(),
    launch: { enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50,
      stopLossPct: 35, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
      requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: 2000000 } };
  setConfig(vault, { ...base, maxHoldingPct: 10 }, Date.now());
  setConfig(vault, { ...base, maxHoldingPct: 90 }, Date.now());
  assert.equal(getConfig(vault).maxHoldingPct, 90);
});

// A config saved before Discovery Bot (or snipes/limitOrders before it)
// existed has no such key in its stored JSON at all - the exact shape an
// early adopter's real saved config is in today. getConfig must back-fill
// the missing sections rather than hand the client `config.discovery.enabled`
// on undefined.
test("getConfig backfills sections missing from an older saved config", () => {
  const vault = "0x" + "e".repeat(40);
  const legacyCfg = { launch: { enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50,
    stopLossPct: 35, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
    requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: 2000000 }, rules: [], maxHoldingPct: 40 };
  setConfig(vault, legacyCfg, Date.now());
  const loaded = getConfig(vault);
  assert.deepEqual(loaded.discovery, emptyConfig().discovery);
  assert.deepEqual(loaded.snipes, []);
  assert.deepEqual(loaded.limitOrders, []);
  assert.deepEqual(loaded.launch, legacyCfg.launch);
});

test("pendingCloseIds is empty for a vault with no close requests", () => {
  const vault = "0x" + "e".repeat(40);
  assert.deepEqual(pendingCloseIds(vault), []);
});

test("requestClose then pendingCloseIds round-trips the position id", () => {
  const vault = "0x" + "f".repeat(40);
  requestClose(vault, 7, Date.now());
  assert.deepEqual(pendingCloseIds(vault), [7]);
});

test("requestClose is idempotent - clicking twice does not duplicate the request", () => {
  const vault = "0x1".padEnd(42, "1");
  requestClose(vault, 3, Date.now());
  requestClose(vault, 3, Date.now());
  assert.deepEqual(pendingCloseIds(vault), [3]);
});

test("requestClose is case-insensitive on the vault address, like config", () => {
  const lower = "0x2".padEnd(42, "2");
  requestClose(lower.toUpperCase(), 9, Date.now());
  assert.deepEqual(pendingCloseIds(lower), [9]);
});

test("pendingDiscoveryBuyIds is empty for a vault with no buy requests", () => {
  const vault = "0x3".padEnd(42, "3");
  assert.deepEqual(pendingDiscoveryBuyIds(vault), []);
});

test("requestDiscoveryBuy then pendingDiscoveryBuyIds round-trips the opportunity id", () => {
  const vault = "0x4".padEnd(42, "4");
  requestDiscoveryBuy(vault, 12, Date.now());
  assert.deepEqual(pendingDiscoveryBuyIds(vault), [12]);
});

test("requestDiscoveryBuy is idempotent - clicking twice does not duplicate the request", () => {
  const vault = "0x5".padEnd(42, "5");
  requestDiscoveryBuy(vault, 4, Date.now());
  requestDiscoveryBuy(vault, 4, Date.now());
  assert.deepEqual(pendingDiscoveryBuyIds(vault), [4]);
});
