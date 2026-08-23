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
 *   node scripts/check-token-identity.js VAULT_ADDR TOKEN_ADDR [TOKEN_ADDR ...]
 *
 * No flags - the first address is always the vault, everything after it is
 * a token to check. Kept deliberately flag-free after --vault=0x... proved
 * to be a real usability trap: it silently misparses if a space or line
 * break lands anywhere inside it (a paste from a wrapped terminal line, for
 * instance), and the tool has no way to tell "malformed flag" apart from
 * "no vault given" - it just quietly skips the balance check instead of
 * erroring, which is exactly what happened the first two times this was run.
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

function isAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

async function main() {
  const args = process.argv.slice(2);
  const [vault, ...tokens] = args;
  if (!isAddress(vault) || tokens.length === 0 || !tokens.every(isAddress)) {
    console.error("Usage: node scripts/check-token-identity.js VAULT_ADDR TOKEN_ADDR [TOKEN_ADDR ...]");
    console.error("Every address must be a full 0x... address (42 characters), the vault first.");
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
    const bal = await c.balanceOf(vault).catch((e) => `ERROR: ${e.message}`);
    const balStr = typeof bal === "bigint" && decimals !== null ? ethers.formatUnits(bal, decimals) : bal;
    console.log(`  vault ${vault} balance = ${balStr}`);
  }
}

main().catch((e) => {
  console.error(`Failed: ${e.message}`);
  process.exit(1);
});
