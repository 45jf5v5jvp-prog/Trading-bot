#!/usr/bin/env node
/**
 * Pays out accrued referral fees, in batches, run manually by the operator.
 *
 * This is deliberately NOT wired into the always-running keeper. The keeper
 * never holds withdrawal rights or spends from the treasury today (see
 * CLAUDE.md's invariants) - giving it the ability to move money OUT of the
 * treasury to pay referrals would be a real expansion of what a compromised
 * keeper key could do. This script uses the TREASURY key instead, and is
 * meant to be run by hand (or from your own cron, on your own schedule) by
 * whoever holds that key.
 *
 * NEVER put the treasury private key in this repo, in an env file that gets
 * committed, or in any chat. Set TREASURY_PRIVATE_KEY as a real environment
 * variable on whatever machine you run this from, and nowhere else - same
 * rule HANDOFF.md already states for the keeper's own key.
 *
 * Run from the site/ directory on the droplet (or set SITE_DB_PATH /
 * KEEPER_DB_PATH explicitly) so it reads the exact same site.db and
 * keeper.db the live dashboard does - see site/lib/store.js and
 * site/lib/keeperDb.js for how those paths resolve.
 *
 * Usage:
 *   TREASURY_PRIVATE_KEY=0x... node scripts/pay-referrals.js [--dry-run] [--min-pls=1]
 */
const path = require("path");
const { Wallet, JsonRpcProvider, Contract, parseEther, formatEther, ZeroAddress } = require("ethers");

const SITE_LIB = path.join(__dirname, "..", "site", "lib");
const { CHAIN } = require(path.join(SITE_LIB, "chain"));
const store = require(path.join(SITE_LIB, "store"));
const keeperDb = require(path.join(SITE_LIB, "keeperDb"));
const { REFERRAL_SHARE_OF_FEE } = require(path.join(SITE_LIB, "referral"));

const VAULT_FACTORY_ABI = ["function vaultOf(address) view returns (address)"];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const VAULT_ABI = ["function deposit(address token, uint256 amount)"];

function getAllReferrers() {
  // No dedicated "list all referrers" query in store.js yet (nothing else
  // needed one) - built here from the one primitive that does exist rather
  // than adding a query only this script uses.
  const db = require("better-sqlite3")(store.DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT DISTINCT referrer FROM referrals").all().map((r) => r.referrer);
  } finally {
    db.close();
  }
}

function pendingFor(referrer) {
  const vaults = store.getReferredVaults(referrer);
  const totalFeesPls = vaults.reduce((sum, v) => sum + keeperDb.getTotalFees(v), 0);
  const totalEarnedPls = totalFeesPls * REFERRAL_SHARE_OF_FEE;
  const totalPaidPls = store.getReferralPaidTotal(referrer);
  return Math.max(0, totalEarnedPls - totalPaidPls);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const minArg = process.argv.find((a) => a.startsWith("--min-pls="));
  const minPls = minArg ? Number(minArg.split("=")[1]) : 1; // skip dust below this

  if (!dryRun && !process.env.TREASURY_PRIVATE_KEY) {
    console.error("TREASURY_PRIVATE_KEY not set. Use --dry-run to preview without it.");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(CHAIN.rpcUrl);
  const wallet = dryRun ? null : new Wallet(process.env.TREASURY_PRIVATE_KEY, provider);
  const factory = new Contract(CHAIN.vaultFactory, VAULT_FACTORY_ABI, provider);
  const wrapped = wallet ? new Contract(CHAIN.wrapped, ERC20_ABI, wallet) : null;

  const referrers = getAllReferrers();
  console.log(`${referrers.length} referrer(s) on record.`);

  for (const referrer of referrers) {
    const pendingPls = pendingFor(referrer);
    if (pendingPls < minPls) {
      console.log(`${referrer}: ${pendingPls.toFixed(6)} ${CHAIN.baseSymbol} pending, below --min-pls, skipping.`);
      continue;
    }

    const referrerVault = await factory.vaultOf(referrer);
    if (referrerVault === ZeroAddress) {
      console.log(`${referrer}: ${pendingPls.toFixed(6)} ${CHAIN.baseSymbol} pending, but no vault yet - will pay once they create one.`);
      continue;
    }

    console.log(`${referrer}: paying ${pendingPls.toFixed(6)} ${CHAIN.baseSymbol} into vault ${referrerVault}${dryRun ? " (dry run)" : ""}.`);
    if (dryRun) continue;

    const amount = parseEther(pendingPls.toFixed(18));
    const vault = new Contract(referrerVault, VAULT_ABI, wallet);

    const currentAllowance = await wrapped.allowance(await wallet.getAddress(), referrerVault);
    if (currentAllowance < amount) {
      const approveTx = await wrapped.approve(referrerVault, amount);
      await approveTx.wait();
    }
    const depositTx = await vault.deposit(CHAIN.wrapped, amount);
    const receipt = await depositTx.wait();

    store.recordReferralPayout(referrer, Number(formatEther(amount)), receipt.hash, Date.now());
    console.log(`  paid: ${receipt.hash}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
