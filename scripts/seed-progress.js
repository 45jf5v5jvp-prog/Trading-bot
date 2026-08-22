#!/usr/bin/env node
/**
 * Prints market-wide seeding progress: how many PulseX pairs have been
 * classified so far, how many of those are WPLS pairs, how many tokens
 * actually cleared the liquidity bar and are being watched/traded, and
 * whether the scan has caught up to the live pair count (it never really
 * "finishes" - PulseX keeps minting new pairs - so "done" here means
 * "caught up as of right now," not "will never need to run again."
 *
 * Usage: node scripts/seed-progress.js
 * (Override RPC_URL, FACTORY, or DB_PATH env vars to match a non-default
 * setup - same variables the keeper itself reads.)
 */
const path = require("path");

let ethers, Database;
try {
  ethers = require("ethers");
  Database = require("better-sqlite3");
} catch {
  // No package.json/node_modules of its own - same fallback vault-count.js
  // uses, borrowing the keeper's, which is guaranteed to exist wherever the
  // keeper itself is actually running.
  ethers = require(path.join(__dirname, "..", "keeper", "node_modules", "ethers"));
  Database = require(path.join(__dirname, "..", "keeper", "node_modules", "better-sqlite3"));
}

const RPC_URL = process.env.RPC_URL || "https://rpc.pulsechain.com";
const FACTORY = process.env.FACTORY || "0x29eA7545DEf87022BAdc76323F373EA1e707C523";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "keeper", "keeper.db");

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const factory = new ethers.Contract(FACTORY, ["function allPairsLength() view returns (uint256)"], provider);
  const totalPairsNow = Number(await factory.allPairsLength());

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const classifiedUpTo = Number(
    db.prepare("SELECT v FROM meta WHERE k = 'marketSeedClassifiedUpTo'").get()?.v ?? 0,
  );
  const wplsPairsFound = db.prepare("SELECT COUNT(*) AS n FROM wpls_pairs").get().n;
  const tokensWatched = db.prepare("SELECT COUNT(*) AS n FROM watched").get().n;
  db.close();

  const pct = totalPairsNow > 0 ? ((classifiedUpTo / totalPairsNow) * 100).toFixed(1) : "0.0";
  console.log(`PulseX pairs that exist right now: ${totalPairsNow}`);
  console.log(`Classified so far: ${classifiedUpTo} (${pct}%)`);
  console.log(`WPLS pairs found among those: ${wplsPairsFound}`);
  console.log(`Tokens actually watched/tradeable (cleared the liquidity bar): ${tokensWatched}`);
  console.log(classifiedUpTo >= totalPairsNow
    ? "Caught up to the current pair count - still watching for new ones as they're created."
    : `Still working through the backlog - ${totalPairsNow - classifiedUpTo} pairs left to classify.`);
}

main().catch((e) => {
  console.error(`Failed to read seeding progress: ${e.message}`);
  process.exit(1);
});
