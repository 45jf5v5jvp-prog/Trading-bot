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

/** Same shape, for "buy this Discovery/Hunter Bot opportunity now" - binds
 * the specific amount into the message, same reasoning as
 * buildAskBuyMessage below: a signature authorizing 500 PLS must never be
 * replayable as authorization for a different amount. */
function buildBuyOpportunityMessage(vaultAddress, opportunityId, amountPls, timestampMs) {
  return `Icaria: buy opportunity ${opportunityId} for vault ${vaultAddress.toLowerCase()} spending ${amountPls} PLS at ${timestampMs}`;
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
 * the owner who benefits from having been referred. Binds the exact
 * referral CODE into the signed message, never the referrer's actual
 * address - the client only ever knows the opaque code, and the server
 * resolves code -> address itself after the signature checks out (see
 * lib/store.js's resolveReferralCode). This keeps a referrer's wallet
 * address out of anything a browser has to handle or sign. */
function buildReferralMessage(vaultAddress, code, timestampMs) {
  return `Icaria: set referrer via code ${code} for vault ${vaultAddress.toLowerCase()} at ${timestampMs}`;
}

/** Same shape, for "I just sent this token to my vault, please start
 * tracking it" - see pages/api/vaults/[address]/deposit-notices.js. This
 * doesn't authorize spending anything (the transfer itself is the owner's
 * own separate signed wallet transaction, not this message) - it only tells
 * the keeper which token to look at, so the signature exists mainly to stop
 * an unauthenticated caller from making the keeper burn RPC calls checking
 * arbitrary token addresses against someone else's vault all day. */
function buildDepositNoticeMessage(vaultAddress, token, timestampMs) {
  return `Icaria: track a deposited token ${token.toLowerCase()} for vault ${vaultAddress.toLowerCase()} at ${timestampMs}`;
}

/** Same shape, for a Talk to Your Hunter chat message. Binds a hash of the
 * text rather than the text itself - the signed message a wallet shows the
 * owner stays a fixed, readable length regardless of how long their message
 * is, while still making a signature for one message unusable to authorize
 * any other. The server recomputes the same hash from the text in the
 * request body and only accepts a match. */
function buildHunterChatMessage(vaultAddress, textHash, timestampMs) {
  return `Icaria: talk to Hunter Bot (${textHash}) for vault ${vaultAddress.toLowerCase()} at ${timestampMs}`;
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

async function authorizeBuyOpportunity({ vaultAddress, opportunityId, amountPls, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildBuyOpportunityMessage(vaultAddress, opportunityId, amountPls, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

async function authorizeAskBuy({ vaultAddress, token, amountPls, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildAskBuyMessage(vaultAddress, token, amountPls, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

async function authorizeReferral({ vaultAddress, code, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildReferralMessage(vaultAddress, code, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

async function authorizeHunterChat({ vaultAddress, textHash, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildHunterChatMessage(vaultAddress, textHash, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

async function authorizeDepositNotice({ vaultAddress, token, timestampMs, signature, rpcUrl, readOwner = defaultReadOwner }) {
  checkFresh(timestampMs);
  const expectedMessage = buildDepositNoticeMessage(vaultAddress, token, timestampMs);
  return authorizeVaultAction({ vaultAddress, message: expectedMessage, signature, rpcUrl, readOwner });
}

module.exports = {
  authorizeConfigWrite, authorizeClose, authorizeBuyOpportunity, authorizeAskBuy, authorizeReferral, authorizeHunterChat, authorizeDepositNotice, authorizeVaultAction,
  buildMessage, buildCloseMessage, buildBuyOpportunityMessage, buildAskBuyMessage, buildReferralMessage, buildHunterChatMessage, buildDepositNoticeMessage, MESSAGE_MAX_AGE_MS,
  defaultReadOwner,
};
