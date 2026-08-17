const { verifyMessage, JsonRpcProvider, Contract } = require("ethers");

/**
 * Authorizing a config write.
 *
 * A vault is a smart contract, not a wallet - it has no private key, so it
 * cannot "sign" anything. The only person allowed to change a vault's bot
 * settings is that vault's owner, and the only trustworthy source for who
 * that is is the vault contract itself on chain. So authorization here is
 * two independent checks, both required:
 *
 *   1. The request is signed by SOME wallet (proves the caller controls that
 *      private key).
 *   2. That wallet is, right now, the on-chain owner() of the vault being
 *      written to (proves that wallet has the right to touch this vault).
 *
 * Trusting a client-supplied "I am the owner" claim without step 2 would let
 * anyone overwrite anyone else's bot settings.
 */

const VAULT_ABI = ["function owner() view returns (address)"];
const MESSAGE_MAX_AGE_MS = 5 * 60 * 1000; // signed messages are stale after 5 minutes

function buildMessage(vaultAddress, timestampMs) {
  return `Icaria: update bot config for vault ${vaultAddress.toLowerCase()} at ${timestampMs}`;
}

/** Default reader: an actual on-chain call. Tests inject a fake instead, so no
 * test in this codebase ever makes a real network call for this function. */
async function defaultReadOwner(vaultAddress, rpcUrl) {
  const provider = new JsonRpcProvider(rpcUrl);
  const vault = new Contract(vaultAddress, VAULT_ABI, provider);
  return vault.owner();
}

/**
 * Throws Error with a caller-safe message on any authorization failure.
 * `readOwner` defaults to a real chain read; tests override it to avoid
 * network I/O while still exercising the exact same authorization logic.
 */
async function authorizeConfigWrite({ vaultAddress, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  if (!Number.isFinite(timestampMs)) throw new Error("timestamp missing or invalid");
  const age = Date.now() - timestampMs;
  if (age > MESSAGE_MAX_AGE_MS || age < -MESSAGE_MAX_AGE_MS)
    throw new Error("signed message expired, please try saving again");

  const expectedMessage = buildMessage(vaultAddress, timestampMs);
  let signer;
  try {
    signer = verifyMessage(expectedMessage, signature);
  } catch {
    throw new Error("invalid signature");
  }

  let onChainOwner;
  try {
    onChainOwner = await readOwner(vaultAddress, rpcUrl);
  } catch (e) {
    throw new Error(`could not read vault owner on chain: ${e.message}`);
  }

  if (onChainOwner.toLowerCase() !== signer.toLowerCase())
    throw new Error("signer is not this vault's owner");

  return { signer };
}

module.exports = { authorizeConfigWrite, buildMessage, MESSAGE_MAX_AGE_MS };
