const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DB_PATH = path.join(__dirname, "store-test.db");
for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
process.env.SITE_DB_PATH = DB_PATH;

const { getConfig, setConfig } = require("../lib/store");
const { emptyConfig } = require("../lib/schema");

test("getConfig returns the empty default for a vault never written to", () => {
  const c = getConfig("0x" + "9".repeat(40));
  assert.deepEqual(c, emptyConfig());
});

test("setConfig then getConfig round-trips exactly", () => {
  const vault = "0x" + "a".repeat(40);
  const cfg = { launch: { enabled: true, perLaunchPls: 1000, maxPerDay: 4, takeProfitPct: 50,
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
  const cfg = { launch: { enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50,
    stopLossPct: 35, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
    requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: 2000000 }, rules: [], maxHoldingPct: 40 };
  setConfig(lower.toUpperCase(), cfg, Date.now());
  assert.deepEqual(getConfig(lower), cfg);
});

test("setConfig overwrites a previous config for the same vault", () => {
  const vault = "0x" + "d".repeat(40);
  const base = { launch: { enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50,
    stopLossPct: 35, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
    requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: 2000000 }, rules: [], maxHoldingPct: 40 };
  setConfig(vault, { ...base, maxHoldingPct: 10 }, Date.now());
  setConfig(vault, { ...base, maxHoldingPct: 90 }, Date.now());
  assert.equal(getConfig(vault).maxHoldingPct, 90);
});
