#!/usr/bin/env node
/**
 * Prints how many vaults have been created against the live VaultFactory -
 * a plain on-chain read, no key needed. Kept as a real script (not just a
 * one-off shell command) so it survives past any one chat session; see
 * DEPLOYED-ADDRESSES.md for how the VAULT_FACTORY default here was verified.
 *
 * Usage: node scripts/vault-count.js
 * (Override RPC_URL or VAULT_FACTORY env vars if ever pointing at a
 * redeployed factory or a different chain.)
 */
const path = require("path");

let ethers;
try {
  ethers = require("ethers");
} catch {
  // Falls back to the keeper's own node_modules - this script has no
  // package.json/node_modules of its own, and the keeper's is guaranteed
  // to exist wherever the keeper itself is actually running.
  ethers = require(path.join(__dirname, "..", "keeper", "node_modules", "ethers"));
}

const RPC_URL = process.env.RPC_URL || "https://rpc.pulsechain.com";
const VAULT_FACTORY = process.env.VAULT_FACTORY || "0x5B5d3B68814857695F3Fedfe0543F03166Bc73e0";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const factory = new ethers.Contract(VAULT_FACTORY, ["function vaultCount() view returns (uint256)"], provider);
  const count = await factory.vaultCount();
  console.log(`Vaults created: ${count.toString()}`);
}

main().catch((e) => {
  console.error(`Failed to read vaultCount: ${e.message}`);
  process.exit(1);
});
