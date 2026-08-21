#!/usr/bin/env node
/**
 * One-time correction for a bug in the ORIGINAL backfill-limit-positions.js:
 * it picked the FIRST WPLS transfer out of the vault as "spent_pls," but
 * BotVault.executeSwap sends the fee+gasFee to the treasury BEFORE the much
 * larger swap amount goes to the router (see BotVault.sol) - so every
 * position that script created got spent_pls set to the tiny fee/gas charge
 * instead of the real trade size, wildly inflating its displayed P&L.
 *
 * This finds every position with a recorded source_tx_hash (only ones that
 * script could have created), re-derives the TRUE spent_pls by summing every
 * WPLS transfer out of the vault in that transaction, and corrects the row
 * if it's wrong. Realized P&L on an already-closed position is corrected too
 * (proceeds_pls stays untouched - that's a real, already-executed number;
 * only spent_pls, which was wrong, changes).
 *
 * Dry run by default - prints what it would change and writes nothing.
 *
 * Usage:
 *   node scripts/fix-limit-position-spent.js
 *   node scripts/fix-limit-position-spent.js --apply
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

  const rows = db.prepare(
    "SELECT id, vault, token, tokens_held, spent_pls, proceeds_pls, status, source_tx_hash FROM positions WHERE source_tx_hash IS NOT NULL",
  ).all();
  console.log(`Found ${rows.length} position(s) with a recorded source transaction. Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (nothing written)"}\n`);

  let corrected = 0;
  let alreadyRight = 0;
  let failed = 0;

  for (const r of rows) {
    const vault = r.vault.toLowerCase();
    let receipt;
    try {
      receipt = await provider.getTransactionReceipt(r.source_tx_hash);
    } catch (e) {
      console.error(`  [FAIL] position #${r.id} tx=${r.source_tx_hash}: could not fetch receipt (${e.message})`);
      failed++;
      continue;
    }
    if (!receipt) {
      console.error(`  [FAIL] position #${r.id} tx=${r.source_tx_hash}: no receipt found on chain`);
      failed++;
      continue;
    }

    const transfers = decodeTransfers(receipt);
    const wplsOutTotal = transfers
      .filter((t) => t.from === vault && t.token === WPLS)
      .reduce((sum, t) => sum + t.value, 0n);
    const trueSpentPls = Number(ethers.formatEther(wplsOutTotal));

    // A few cents of float/rounding drift is fine; anything bigger means the
    // original backfill really did get it wrong for this row.
    if (Math.abs(trueSpentPls - r.spent_pls) < 0.01) {
      alreadyRight++;
      continue;
    }

    console.log(
      `  [${APPLY ? "APPLY" : "DRY RUN"}] position #${r.id} (${r.status}) token=${r.token} ` +
      `spent_pls ${r.spent_pls} -> ${trueSpentPls}` +
      (r.proceeds_pls != null ? ` (realized P&L was ${(r.proceeds_pls - r.spent_pls).toFixed(2)}, becomes ${(r.proceeds_pls - trueSpentPls).toFixed(2)})` : ""),
    );

    if (APPLY) {
      const tokens = Number(ethers.formatEther(BigInt(r.tokens_held)));
      const entry = tokens > 0 ? trueSpentPls / tokens : 0;
      db.prepare("UPDATE positions SET spent_pls = ?, entry_price = ? WHERE id = ?").run(trueSpentPls, entry, r.id);
    }
    corrected++;
  }

  console.log(
    `\n${APPLY ? "Corrected" : "Would correct"} ${corrected} position(s). ` +
    `${alreadyRight} already correct. ${failed} failed to look up.`,
  );
  if (!APPLY && corrected > 0) {
    console.log(`Nothing was written. Re-run with --apply once these numbers look right.`);
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
