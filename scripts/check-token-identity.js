#!/usr/bin/env node
/**
 * Independent, on-chain check of what's actually deployed at a token address
 * - and, if a vault address is given, that vault's real current balance of
 * it - completely bypassing the site's display and the keeper's own DB.
 * Built for the 2026-08-23 investigation into Stuck Positions the owner
 * believed were misclassified: some claimed "WETH"/"Atropa"/etc addresses
 * needed verifying against what's really on PulseChain, since a token's own
 * symbol()/name() are just strings the contract picks - not proof of what it
 * actually is. A scam contract can be deployed at (or made to look like) a
 * well-known address specifically to borrow trust from the real thing.
 *
 * Usage:
 *   node scripts/check-token-identity.js TOKEN_ADDR [TOKEN_ADDR ...] [--vault=0x...]
 */
const path = require("path");

let ethers;
try {
  ethers = require("ethers");
} catch {
  ethers = require(path.join(__dirname, "..", "keeper", "node_modules", "ethers"));
}

const RPC_URL = process.env.RPC_URL || "https://rpc.pulsechain.com";
const ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const args = process.argv.slice(2);
  const vaultArg = args.find((a) => a.startsWith("--vault="));
  const vault = vaultArg ? vaultArg.slice("--vault=".length) : null;
  const tokens = args.filter((a) => !a.startsWith("--"));
  if (tokens.length === 0) {
    console.error("Usage: node scripts/check-token-identity.js TOKEN_ADDR [TOKEN_ADDR ...] [--vault=0x...]");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  for (const addr of tokens) {
    const code = await provider.getCode(addr);
    if (code === "0x") {
      console.log(`${addr}: NO CONTRACT DEPLOYED at this address on this chain`);
      continue;
    }
    const c = new ethers.Contract(addr, ABI, provider);
    const [symbol, name, decimals, supply] = await Promise.all([
      c.symbol().catch(() => "(symbol() reverted)"),
      c.name().catch(() => "(name() reverted)"),
      c.decimals().catch(() => null),
      c.totalSupply().catch(() => null),
    ]);
    const supplyStr = supply !== null && decimals !== null ? ethers.formatUnits(supply, decimals) : "unknown";
    console.log(`${addr}:`);
    console.log(`  symbol=${symbol}  name=${name}  decimals=${decimals}`);
    console.log(`  totalSupply=${supplyStr}`);
    if (vault) {
      const bal = await c.balanceOf(vault).catch((e) => `ERROR: ${e.message}`);
      const balStr = typeof bal === "bigint" && decimals !== null ? ethers.formatUnits(bal, decimals) : bal;
      console.log(`  vault ${vault} balance = ${balStr}`);
    }
  }
}

main().catch((e) => {
  console.error(`Failed: ${e.message}`);
  process.exit(1);
});
