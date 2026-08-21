#!/usr/bin/env node
/**
 * One-time recovery for a real bug: a filled limit-order BUY never created a
 * tracked position (see keeper/src/limits.ts's fireOrder, fixed alongside
 * this script) - the tokens landed in the vault but there was no P&L, no
 * Close Position button, nothing. This finds every recorded limit-order
 * fill, reconstructs what actually happened from the transaction's own
 * Transfer logs on chain (not from current, possibly-since-edited order
 * settings), and inserts a matching position - skipping anything already
 * backfilled (tracked via source_tx_hash) or that turns out to be a sell
 * fill, which never needed one.
 *
 * Dry run by default - prints exactly what it would create and writes
 * nothing. Re-run with --apply once the numbers look right.
 *
 * Usage (from the repo root, on the droplet where keeper.db actually is):
 *   node scripts/backfill-limit-positions.js
 *   node scripts/backfill-limit-positions.js --apply
 *
 * Override RPC_URL, DB_PATH, or WPLS via env if this deployment's defaults
 * (PulseChain mainnet, ./keeper/keeper.db, PulseChain's WPLS) don't apply.
 */
const path = require("path");

let ethers;
try {
  ethers = require("ethers");
} catch {
  ethers = require(path.join(__dirname, "..", "keeper", "node_modules", "ethers"));
}
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = require(path.join(__dirname, "..", "keeper", "node_modules", "better-sqlite3"));
}

const RPC_URL = process.env.RPC_URL || "https://rpc.pulsechain.com";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "keeper", "keeper.db");
const WPLS = (process.env.WPLS || "0xA1077a294dDE1B09bB078844df40758a5D0f9a27").toLowerCase();
const APPLY = process.argv.includes("--apply");

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

function decodeTransfers(receipt) {
  return receipt.logs
    .filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({
      token: l.address.toLowerCase(),
      from: ethers.getAddress(`0x${l.topics[1].slice(26)}`).toLowerCase(),
      to: ethers.getAddress(`0x${l.topics[2].slice(26)}`).toLowerCase(),
      value: BigInt(l.data),
    }));
}

async function main() {
  const db = new Database(DB_PATH);
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const fires = db.prepare(
    "SELECT vault, order_id, ts, tx_hash FROM limit_fires WHERE tx_hash IS NOT NULL",
  ).all();
  console.log(`Found ${fires.length} recorded limit-order fill(s). Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (nothing written)"}\n`);

  let created = 0;
  let skippedExisting = 0;
  let skippedSell = 0;
  let failed = 0;

  for (const f of fires) {
    const vault = f.vault.toLowerCase();

    const existing = db.prepare("SELECT id FROM positions WHERE source_tx_hash = ?").get(f.tx_hash);
    if (existing) {
      skippedExisting++;
      continue;
    }

    let receipt;
    try {
      receipt = await provider.getTransactionReceipt(f.tx_hash);
    } catch (e) {
      console.error(`  [FAIL] ${f.tx_hash}: could not fetch receipt (${e.message})`);
      failed++;
      continue;
    }
    if (!receipt) {
      console.error(`  [FAIL] ${f.tx_hash}: no receipt found on chain`);
      failed++;
      continue;
    }

    const transfers = decodeTransfers(receipt);
    const tokenIn = transfers.find((t) => t.to === vault && t.token !== WPLS);
    // BotVault.executeSwap sends TWO separate WPLS transfers out of the vault
    // on a buy: fee+gasFee to the treasury FIRST, then the much larger
    // remainder to the router for the actual swap (see BotVault.sol). Taking
    // only the first match (an earlier version of this script's bug) grabs
    // the small fee/gas charge, not the real trade size - summing every
    // vault-outgoing WPLS transfer reconstructs the true full amountIn that
    // was actually debited, which is what spent_pls means everywhere else in
    // this codebase (see launch.ts/hunter.ts's own openPosition calls).
    const wplsOutTotal = transfers
      .filter((t) => t.from === vault && t.token === WPLS)
      .reduce((sum, t) => sum + t.value, 0n);

    if (!tokenIn) {
      // Nothing non-WPLS arrived at the vault in this transaction - either a
      // sell fill (proceeds only, no new position to track) or something
      // unexpected. Either way, not a buy to backfill.
      skippedSell++;
      continue;
    }

    const spentPls = Number(ethers.formatEther(wplsOutTotal));
    console.log(
      `  [${APPLY ? "APPLY" : "DRY RUN"}] vault=${vault} order=${f.order_id} token=${tokenIn.token} ` +
      `tokensOut(raw)=${tokenIn.value.toString()} spentPls=${spentPls} tx=${f.tx_hash}`,
    );

    if (APPLY) {
      // Same 18-decimal entry_price convention openPosition() itself uses
      // for every other bot - entry_price is informational only, nothing
      // downstream reads it to decide an exit (that uses spent_pls vs a live
      // quote instead), so this stays consistent with existing behavior
      // rather than introducing a second convention just for this script.
      const tokens = Number(ethers.formatEther(tokenIn.value));
      const entry = tokens > 0 ? spentPls / tokens : 0;
      db.prepare(`INSERT INTO positions
        (vault,bot,token,opened_at,entry_price,spent_pls,tokens_held,high_water,tp_pct,sl_pct,trail_pct,time_exit_min,status,exit_mode,source_tx_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'open',NULL,?)`).run(
        vault, "limit", tokenIn.token, f.ts, entry, spentPls, tokenIn.value.toString(), 1.0,
        0, null, null, null, f.tx_hash,
      );
    }
    created++;
  }

  console.log(
    `\n${APPLY ? "Created" : "Would create"} ${created} position(s). ` +
    `Skipped ${skippedExisting} already-backfilled, ${skippedSell} sell fill(s). ${failed} failed to look up.`,
  );
  if (!APPLY && created > 0) {
    console.log(`Nothing was written. Re-run with --apply once these numbers look right.`);
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
