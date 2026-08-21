const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DB_PATH = path.join(__dirname, "store-test.db");
for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
process.env.SITE_DB_PATH = DB_PATH;

const { getConfig, setConfig, requestClose, pendingCloseIds, requestDiscoveryBuy, pendingDiscoveryBuyRequests, requestHunterFeedback, pendingHunterFeedback, requestAskBuy, pendingAskBuyRequests, getReferrer, setReferrer, getWalletReferrer, lockWalletReferrer, getReferredVaults, getReferralPaidTotal, recordReferralPayout, getOrCreateReferralCode, resolveReferralCode } = require("../lib/store");
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

test("pendingDiscoveryBuyRequests is empty for a vault with no buy requests", () => {
  const vault = "0x3".padEnd(42, "3");
  assert.deepEqual(pendingDiscoveryBuyRequests(vault), []);
});

test("requestDiscoveryBuy then pendingDiscoveryBuyRequests round-trips the opportunity id and the typed-in amount", () => {
  const vault = "0x4".padEnd(42, "4");
  requestDiscoveryBuy(vault, 12, Date.now(), 750);
  assert.deepEqual(pendingDiscoveryBuyRequests(vault), [{ id: 12, amountPls: 750 }]);
});

test("requestDiscoveryBuy defaults amountPls to null when omitted (a pre-existing request, before this feature)", () => {
  const vault = "0x9".padEnd(42, "9");
  requestDiscoveryBuy(vault, 20, Date.now());
  assert.deepEqual(pendingDiscoveryBuyRequests(vault), [{ id: 20, amountPls: null }]);
});

test("requestDiscoveryBuy is idempotent - clicking twice does not duplicate the request", () => {
  const vault = "0x5".padEnd(42, "5");
  requestDiscoveryBuy(vault, 4, Date.now(), 200);
  requestDiscoveryBuy(vault, 4, Date.now(), 200);
  assert.deepEqual(pendingDiscoveryBuyRequests(vault), [{ id: 4, amountPls: 200 }]);
});

test("pendingHunterFeedback is empty for a vault with no feedback", () => {
  const vault = "0xa".padEnd(42, "a");
  assert.deepEqual(pendingHunterFeedback(vault), []);
});

test("requestHunterFeedback then pendingHunterFeedback round-trips the text, oldest first", () => {
  const vault = "0xb".padEnd(42, "b");
  requestHunterFeedback(vault, "Skip anything with under 5M PLS liquidity.", Date.now());
  requestHunterFeedback(vault, "Weight RSI more than MACD.", Date.now());
  const rows = pendingHunterFeedback(vault);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, "Skip anything with under 5M PLS liquidity.");
  assert.equal(rows[1].text, "Weight RSI more than MACD.");
  assert.ok(Number.isInteger(rows[0].id) && Number.isInteger(rows[1].id));
});

test("requestHunterFeedback does not dedup - two separate pieces of feedback both persist", () => {
  const vault = "0xc".padEnd(42, "c");
  requestHunterFeedback(vault, "same text", Date.now());
  requestHunterFeedback(vault, "same text", Date.now());
  assert.equal(pendingHunterFeedback(vault).length, 2);
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
  const owner = "0x" + "aa".repeat(20);
  const referrer = ("0x" + "12".repeat(20)).toUpperCase();
  setReferrer(vault, referrer, Date.now(), owner);
  assert.equal(getReferrer(vault), referrer.toLowerCase());
});

test("setReferrer rejects the vault's owner referring themselves", () => {
  const vault = "0x" + "13".repeat(20);
  const owner = "0x" + "ab".repeat(20);
  assert.throws(() => setReferrer(vault, owner, Date.now(), owner), /cannot refer itself/);
  assert.equal(getReferrer(vault), null);
});

test("setReferrer re-submitting the SAME referrer is a harmless no-op", () => {
  const vault = "0x" + "14".repeat(20);
  const owner = "0x" + "ac".repeat(20);
  const referrer = "0x" + "15".repeat(20);
  setReferrer(vault, referrer, Date.now(), owner);
  assert.doesNotThrow(() => setReferrer(vault, referrer, Date.now(), owner));
  assert.equal(getReferrer(vault), referrer);
});

test("setReferrer silently keeps the ORIGINAL referrer when a different one is submitted for an already-bound vault (Referral Protections)", () => {
  const vault = "0x" + "16".repeat(20);
  const owner = "0x" + "ad".repeat(20);
  const first = "0x" + "17".repeat(20);
  const second = "0x" + "18".repeat(20);
  setReferrer(vault, first, Date.now(), owner);
  assert.doesNotThrow(() => setReferrer(vault, second, Date.now(), owner));
  assert.equal(getReferrer(vault), first); // unchanged - never redirects an already-earned credit
});

test("getReferredVaults lists every vault credited to a referrer, and none belonging to someone else", () => {
  const referrer = "0x" + "19".repeat(20);
  const other = "0x" + "20".repeat(20);
  const vaultA = "0x" + "21".repeat(20);
  const vaultB = "0x" + "22".repeat(20);
  const vaultC = "0x" + "23".repeat(20);
  const ownerA = "0x" + "ae".repeat(20);
  const ownerB = "0x" + "af".repeat(20);
  const ownerC = "0x" + "b0".repeat(20);
  setReferrer(vaultA, referrer, Date.now(), ownerA);
  setReferrer(vaultB, referrer, Date.now(), ownerB);
  setReferrer(vaultC, other, Date.now(), ownerC);
  const referred = getReferredVaults(referrer);
  assert.equal(referred.length, 2);
  assert.ok(referred.includes(vaultA));
  assert.ok(referred.includes(vaultB));
  assert.ok(!referred.includes(vaultC));
});

test("Referral Protections: a second vault from an already-referred owner is credited to the SAME referrer, even with a different code submitted", () => {
  const owner = "0x" + "c1".repeat(20);
  const originalReferrer = "0x" + "c2".repeat(20);
  const selfReferralAttempt = "0x" + "c3".repeat(20);
  const vault1 = "0x" + "c4".repeat(20);
  const vault2 = "0x" + "c5".repeat(20);

  setReferrer(vault1, originalReferrer, Date.now(), owner);
  assert.equal(getReferrer(vault1), originalReferrer);

  // Same owner, second vault, tries to bind a DIFFERENT referrer (the
  // exploit: self-referring on vault #2 to dodge crediting vault #1's
  // referrer). Must silently land on the original referrer instead.
  setReferrer(vault2, selfReferralAttempt, Date.now(), owner);
  assert.equal(getReferrer(vault2), originalReferrer);
  assert.equal(getWalletReferrer(owner), originalReferrer);
});

test("Referral Protections: a wallet's first-ever binding locks it for every vault after", () => {
  const owner = "0x" + "d1".repeat(20);
  const referrer = "0x" + "d2".repeat(20);
  const vault1 = "0x" + "d3".repeat(20);
  assert.equal(getWalletReferrer(owner), null);
  setReferrer(vault1, referrer, Date.now(), owner);
  assert.equal(getWalletReferrer(owner), referrer);
});

test("lockWalletReferrer is first-write-wins - a later different referrer is ignored", () => {
  const owner = "0x" + "e1".repeat(20);
  const first = "0x" + "e2".repeat(20);
  const second = "0x" + "e3".repeat(20);
  lockWalletReferrer(owner, first, Date.now());
  lockWalletReferrer(owner, second, Date.now());
  assert.equal(getWalletReferrer(owner), first);
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

test("getOrCreateReferralCode returns the SAME code on repeated calls for the same wallet", () => {
  const referrer = "0x" + "30".repeat(20);
  const first = getOrCreateReferralCode(referrer);
  const second = getOrCreateReferralCode(referrer);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{16}$/);
});

test("getOrCreateReferralCode gives different wallets different codes", () => {
  const a = getOrCreateReferralCode("0x" + "31".repeat(20));
  const b = getOrCreateReferralCode("0x" + "32".repeat(20));
  assert.notEqual(a, b);
});

test("resolveReferralCode maps a generated code back to its wallet, lowercased", () => {
  const referrer = ("0x" + "33".repeat(20)).toUpperCase();
  const code = getOrCreateReferralCode(referrer);
  assert.equal(resolveReferralCode(code), referrer.toLowerCase());
});

test("resolveReferralCode is null for a code that was never issued", () => {
  assert.equal(resolveReferralCode("0000000000000000"), null);
});
