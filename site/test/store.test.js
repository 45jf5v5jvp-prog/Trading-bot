const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DB_PATH = path.join(__dirname, "store-test.db");
for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
process.env.SITE_DB_PATH = DB_PATH;

const { getConfig, setConfig, requestClose, pendingCloseIds, requestDiscoveryBuy, pendingDiscoveryBuyIds, requestAskBuy, pendingAskBuyRequests, getReferrer, setReferrer, getReferredVaults, getReferralPaidTotal, recordReferralPayout } = require("../lib/store");
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

test("pendingAskBuyRequests is empty for a vault with no requests", () => {
  const vault = "0x6".padEnd(42, "6");
  assert.deepEqual(pendingAskBuyRequests(vault), []);
});

test("requestAskBuy then pendingAskBuyRequests round-trips token and amount", () => {
  const vault = "0x7".padEnd(42, "7");
  const token = "0x" + "a".repeat(40);
  const id = requestAskBuy(vault, token, 1234.5, Date.now());
  const pending = pendingAskBuyRequests(vault);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, id);
  assert.equal(pending[0].token, token);
  assert.equal(pending[0].amountPls, 1234.5);
});

test("requestAskBuy does NOT dedupe - asking to buy the same token twice is two separate requests", () => {
  const vault = "0x8".padEnd(42, "8");
  const token = "0x" + "b".repeat(40);
  requestAskBuy(vault, token, 100, Date.now());
  requestAskBuy(vault, token, 100, Date.now());
  assert.equal(pendingAskBuyRequests(vault).length, 2);
});

test("requestClose is case-insensitive on the vault address, like config", () => {
  const lower = "0x2".padEnd(42, "2");
  requestClose(lower.toUpperCase(), 9, Date.now());
  assert.deepEqual(pendingCloseIds(lower), [9]);
});

test("getReferrer is null for a vault with no referral on record", () => {
  const vault = "0x" + "10".repeat(20);
  assert.equal(getReferrer(vault), null);
});

test("setReferrer then getReferrer round-trips, stored lowercase", () => {
  const vault = "0x" + "11".repeat(20);
  const referrer = ("0x" + "12".repeat(20)).toUpperCase();
  setReferrer(vault, referrer, Date.now());
  assert.equal(getReferrer(vault), referrer.toLowerCase());
});

test("setReferrer rejects a vault referring itself", () => {
  const vault = "0x" + "13".repeat(20);
  assert.throws(() => setReferrer(vault, vault, Date.now()), /cannot refer itself/);
  assert.equal(getReferrer(vault), null);
});

test("setReferrer re-submitting the SAME referrer is a harmless no-op", () => {
  const vault = "0x" + "14".repeat(20);
  const referrer = "0x" + "15".repeat(20);
  setReferrer(vault, referrer, Date.now());
  assert.doesNotThrow(() => setReferrer(vault, referrer, Date.now()));
  assert.equal(getReferrer(vault), referrer);
});

test("setReferrer rejects trying to change an already-bound referrer", () => {
  const vault = "0x" + "16".repeat(20);
  const first = "0x" + "17".repeat(20);
  const second = "0x" + "18".repeat(20);
  setReferrer(vault, first, Date.now());
  assert.throws(() => setReferrer(vault, second, Date.now()), /already has a different referrer/);
  assert.equal(getReferrer(vault), first); // unchanged
});

test("getReferredVaults lists every vault credited to a referrer, and none belonging to someone else", () => {
  const referrer = "0x" + "19".repeat(20);
  const other = "0x" + "20".repeat(20);
  const vaultA = "0x" + "21".repeat(20);
  const vaultB = "0x" + "22".repeat(20);
  const vaultC = "0x" + "23".repeat(20);
  setReferrer(vaultA, referrer, Date.now());
  setReferrer(vaultB, referrer, Date.now());
  setReferrer(vaultC, other, Date.now());
  const referred = getReferredVaults(referrer);
  assert.equal(referred.length, 2);
  assert.ok(referred.includes(vaultA));
  assert.ok(referred.includes(vaultB));
  assert.ok(!referred.includes(vaultC));
});

test("getReferralPaidTotal is 0 for a referrer with no payouts yet", () => {
  const referrer = "0x" + "24".repeat(20);
  assert.equal(getReferralPaidTotal(referrer), 0);
});

test("recordReferralPayout then getReferralPaidTotal sums across multiple payout batches", () => {
  const referrer = "0x" + "25".repeat(20);
  recordReferralPayout(referrer, 10.5, "0xaaa", Date.now());
  recordReferralPayout(referrer, 4.25, "0xbbb", Date.now());
  assert.equal(getReferralPaidTotal(referrer), 14.75);
});
