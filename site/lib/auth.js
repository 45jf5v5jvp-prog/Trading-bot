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

/** Same shape of message, for the "close this position" action - a distinct
 * action string so a signature for one action can never be replayed as
 * authorization for a different one. */
function buildCloseMessage(vaultAddress, positionId, timestampMs) {
  return `Icaria: close position ${positionId} for vault ${vaultAddress.toLowerCase()} at ${timestampMs}`;
}

/** Same shape, for "buy this Discovery Bot opportunity now" - a distinct
 * action string, same replay-prevention reasoning as buildCloseMessage. */
function buildBuyOpportunityMessage(vaultAddress, opportunityId, timestampMs) {
  return `Icaria: buy opportunity ${opportunityId} for vault ${vaultAddress.toLowerCase()} at ${timestampMs}`;
}

/** Same shape, for "buy this exact token and amount from Ask Icaria" - binds
 * the signature to the specific token AND amount, unlike the opportunity-id
 * buy above, since there's no pre-existing catalog entry to reference; a
 * signature for 1000 PLS of token A must never authorize any other amount
 * or token. */
function buildAskBuyMessage(vaultAddress, token, amountPls, timestampMs) {
  return `Icaria: buy ${amountPls} PLS of ${token.toLowerCase()} for vault ${vaultAddress.toLowerCase()} at ${timestampMs}`;
}

/** Same shape, for binding a vault's referrer - the vault's owner must sign
 * this, not the referrer, since it's the owner's fee that's being split and
 * the owner who benefits from having been referred. Binds the exact referrer
 * address into the signed message so a captured signature can never be
 * replayed to bind a different referrer later. */
function buildReferralMessage(vaultAddress, referrer, timestampMs) {
  return `Icaria: set referrer ${referrer.toLowerCase()} for vault ${vaultAddress.toLowerCase()} at ${timestampMs}`;
}

function checkFresh(timestampMs) {
  if (!Number.isFinite(timestampMs)) throw new Error("timestamp missing or invalid");
  const age = Date.now() - timestampMs;
  if (age > MESSAGE_MAX_AGE_MS || age < -MESSAGE_MAX_AGE_MS)
    throw new Error("signed message expired, please try again");
}

/** Default reader: an actual on-chain call. Tests inject a fake instead, so no
 * test in this codebase ever makes a real network call for this function. */
async function defaultReadOwner(vaultAddress, rpcUrl) {
  const provider = new JsonRpcProvider(rpcUrl);
  const vault = new Contract(vaultAddress, VAULT_ABI, provider);
  return vault.owner();
}

/**
 * Core of every vault-owner-gated action: the caller must have signed
 * `message` with the wallet that is, right now, the on-chain owner() of
 * `vaultAddress`. Throws Error with a caller-safe message on any failure.
 * `readOwner` defaults to a real chain read; tests override it to avoid
 * network I/O while still exercising the exact same authorization logic.
 */
async function authorizeVaultAction({ vaultAddress, message, signature, rpcUrl, readOwner = defaultReadOwner }) {
  let signer;
  try {
    signer = verifyMessage(message, signature);
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

async function authorizeConfigWrite({ vaultAddress, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildMessage(vaultAddress, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

async function authorizeClose({ vaultAddress, positionId, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildCloseMessage(vaultAddress, positionId, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

async function authorizeBuyOpportunity({ vaultAddress, opportunityId, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildBuyOpportunityMessage(vaultAddress, opportunityId, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

async function authorizeAskBuy({ vaultAddress, token, amountPls, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildAskBuyMessage(vaultAddress, token, amountPls, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

async function authorizeReferral({ vaultAddress, referrer, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildReferralMessage(vaultAddress, referrer, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

module.exports = {
  authorizeConfigWrite, authorizeClose, authorizeBuyOpportunity, authorizeAskBuy, authorizeReferral, authorizeVaultAction,
  buildMessage, buildCloseMessage, buildBuyOpportunityMessage, buildAskBuyMessage, buildReferralMessage, MESSAGE_MAX_AGE_MS,
};
