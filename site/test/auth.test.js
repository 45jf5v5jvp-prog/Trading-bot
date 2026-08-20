const test = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");
const { authorizeConfigWrite, authorizeClose, authorizeBuyOpportunity, authorizeAskBuy, authorizeReferral, buildMessage, buildCloseMessage, buildBuyOpportunityMessage, buildAskBuyMessage, buildReferralMessage } = require("../lib/auth");

const VAULT = "0x" + "e".repeat(40);
const wallet = Wallet.createRandom();

// A fake on-chain reader, so these tests never touch the network. It records
// whether it was called at all, which is itself part of what several tests
// verify (bad signatures/timestamps must be rejected BEFORE any chain read).
function fakeReader(ownerToReturn, { throwInstead } = {}) {
  const calls = [];
  const fn = async (vaultAddress, rpcUrl) => {
    calls.push({ vaultAddress, rpcUrl });
    if (throwInstead) throw new Error(throwInstead);
    return ownerToReturn;
  };
  fn.calls = calls;
  return fn;
}

test("rejects an expired timestamp without ever calling the chain reader", async () => {
  const staleTs = Date.now() - 10 * 60 * 1000;
  const signature = await wallet.signMessage(buildMessage(VAULT, staleTs));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeConfigWrite({ vaultAddress: VAULT, timestampMs: staleTs, signature, rpcUrl: "unused", readOwner }),
    /expired/,
  );
  assert.equal(readOwner.calls.length, 0, "must not read chain for an already-expired message");
});

test("rejects a timestamp too far in the future", async () => {
  const futureTs = Date.now() + 10 * 60 * 1000;
  const signature = await wallet.signMessage(buildMessage(VAULT, futureTs));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeConfigWrite({ vaultAddress: VAULT, timestampMs: futureTs, signature, rpcUrl: "unused", readOwner }),
    /expired/,
  );
});

test("rejects a missing/invalid timestamp", async () => {
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeConfigWrite({ vaultAddress: VAULT, timestampMs: NaN, signature: "0xdeadbeef", rpcUrl: "unused", readOwner }),
    /timestamp/,
  );
});

test("rejects a garbage signature without ever calling the chain reader", async () => {
  const ts = Date.now();
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeConfigWrite({ vaultAddress: VAULT, timestampMs: ts, signature: "0xnotasignature", rpcUrl: "unused", readOwner }),
    /invalid signature/,
  );
  assert.equal(readOwner.calls.length, 0, "must not read chain for an unparseable signature");
});

test("rejects when the signer does not match the vault's on-chain owner", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildMessage(VAULT, ts));
  const someoneElse = Wallet.createRandom().address;
  const readOwner = fakeReader(someoneElse); // chain says a different address owns it
  await assert.rejects(
    authorizeConfigWrite({ vaultAddress: VAULT, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /not this vault's owner/,
  );
});

test("rejects a signature made for the WRONG vault address (message mismatch)", async () => {
  const ts = Date.now();
  const otherVault = "0x" + "f".repeat(40);
  const signature = await wallet.signMessage(buildMessage(otherVault, ts)); // signed for a different vault
  const readOwner = fakeReader(wallet.address); // even though this wallet DOES own VAULT
  await assert.rejects(
    authorizeConfigWrite({ vaultAddress: VAULT, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /not this vault's owner/, // recovers a different signer since the signed message text differs
  );
});

test("accepts a correctly-timed, validly-signed request from the vault's real owner", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildMessage(VAULT, ts));
  const readOwner = fakeReader(wallet.address); // chain confirms this wallet owns the vault
  const result = await authorizeConfigWrite({ vaultAddress: VAULT, timestampMs: ts, signature, rpcUrl: "unused", readOwner });
  assert.equal(result.signer.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(readOwner.calls.length, 1);
  assert.equal(readOwner.calls[0].vaultAddress, VAULT);
});

test("surfaces a readable error if the chain read itself fails (e.g. RPC down)", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildMessage(VAULT, ts));
  const readOwner = fakeReader(null, { throwInstead: "connection refused" });
  await assert.rejects(
    authorizeConfigWrite({ vaultAddress: VAULT, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /could not read vault owner on chain/,
  );
});

test("authorizeClose accepts a correctly-signed close request from the real owner", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildCloseMessage(VAULT, 5, ts));
  const readOwner = fakeReader(wallet.address);
  const result = await authorizeClose({ vaultAddress: VAULT, positionId: 5, timestampMs: ts, signature, rpcUrl: "unused", readOwner });
  assert.equal(result.signer.toLowerCase(), wallet.address.toLowerCase());
});

test("authorizeClose rejects a signature made for a DIFFERENT position id", async () => {
  const ts = Date.now();
  // Signed to close position 5, submitted trying to close position 6 - a
  // signature for one action must never authorize a different one.
  const signature = await wallet.signMessage(buildCloseMessage(VAULT, 5, ts));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeClose({ vaultAddress: VAULT, positionId: 6, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /not this vault's owner/,
  );
});

test("authorizeClose rejects an expired timestamp without ever calling the chain reader", async () => {
  const staleTs = Date.now() - 10 * 60 * 1000;
  const signature = await wallet.signMessage(buildCloseMessage(VAULT, 5, staleTs));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeClose({ vaultAddress: VAULT, positionId: 5, timestampMs: staleTs, signature, rpcUrl: "unused", readOwner }),
    /expired/,
  );
  assert.equal(readOwner.calls.length, 0);
});

test("authorizeBuyOpportunity accepts a correctly-signed buy request from the real owner", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildBuyOpportunityMessage(VAULT, 7, 500, ts));
  const readOwner = fakeReader(wallet.address);
  const result = await authorizeBuyOpportunity({ vaultAddress: VAULT, opportunityId: 7, amountPls: 500, timestampMs: ts, signature, rpcUrl: "unused", readOwner });
  assert.equal(result.signer.toLowerCase(), wallet.address.toLowerCase());
});

test("authorizeBuyOpportunity rejects a signature made for a DIFFERENT opportunity id", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildBuyOpportunityMessage(VAULT, 7, 500, ts));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeBuyOpportunity({ vaultAddress: VAULT, opportunityId: 8, amountPls: 500, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /not this vault's owner/,
  );
});

test("authorizeBuyOpportunity rejects a signature made for a DIFFERENT amount (can't retype a bigger spend onto a small-amount signature)", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildBuyOpportunityMessage(VAULT, 7, 500, ts));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeBuyOpportunity({ vaultAddress: VAULT, opportunityId: 7, amountPls: 50000, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /not this vault's owner/,
  );
});

test("authorizeBuyOpportunity rejects an expired timestamp without ever calling the chain reader", async () => {
  const staleTs = Date.now() - 10 * 60 * 1000;
  const signature = await wallet.signMessage(buildBuyOpportunityMessage(VAULT, 7, 500, staleTs));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeBuyOpportunity({ vaultAddress: VAULT, opportunityId: 7, amountPls: 500, timestampMs: staleTs, signature, rpcUrl: "unused", readOwner }),
    /expired/,
  );
  assert.equal(readOwner.calls.length, 0);
});

const ASK_TOKEN = "0x" + "c".repeat(40);

test("authorizeAskBuy accepts a correctly-signed buy request from the real owner", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildAskBuyMessage(VAULT, ASK_TOKEN, 500, ts));
  const readOwner = fakeReader(wallet.address);
  const result = await authorizeAskBuy({ vaultAddress: VAULT, token: ASK_TOKEN, amountPls: 500, timestampMs: ts, signature, rpcUrl: "unused", readOwner });
  assert.equal(result.signer.toLowerCase(), wallet.address.toLowerCase());
});

test("authorizeAskBuy rejects a signature made for a DIFFERENT amount", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildAskBuyMessage(VAULT, ASK_TOKEN, 500, ts));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeAskBuy({ vaultAddress: VAULT, token: ASK_TOKEN, amountPls: 5000, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /invalid signature|not this vault's owner/,
  );
});

test("authorizeAskBuy rejects a signature made for a DIFFERENT token", async () => {
  const ts = Date.now();
  const otherToken = "0x" + "d".repeat(40);
  const signature = await wallet.signMessage(buildAskBuyMessage(VAULT, ASK_TOKEN, 500, ts));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeAskBuy({ vaultAddress: VAULT, token: otherToken, amountPls: 500, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /invalid signature|not this vault's owner/,
  );
});

test("authorizeAskBuy rejects an expired timestamp without ever calling the chain reader", async () => {
  const staleTs = Date.now() - 10 * 60 * 1000;
  const signature = await wallet.signMessage(buildAskBuyMessage(VAULT, ASK_TOKEN, 500, staleTs));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeAskBuy({ vaultAddress: VAULT, token: ASK_TOKEN, amountPls: 500, timestampMs: staleTs, signature, rpcUrl: "unused", readOwner }),
    /expired/,
  );
  assert.equal(readOwner.calls.length, 0);
});

const REFERRER = "0x" + "f".repeat(40);

test("authorizeReferral accepts a correctly-signed referral binding from the real owner", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildReferralMessage(VAULT, REFERRER, ts));
  const readOwner = fakeReader(wallet.address);
  const result = await authorizeReferral({ vaultAddress: VAULT, referrer: REFERRER, timestampMs: ts, signature, rpcUrl: "unused", readOwner });
  assert.equal(result.signer.toLowerCase(), wallet.address.toLowerCase());
});

test("authorizeReferral rejects a signature made for a DIFFERENT referrer (can't retarget a captured signature)", async () => {
  const ts = Date.now();
  const otherReferrer = "0x" + "1".repeat(40);
  const signature = await wallet.signMessage(buildReferralMessage(VAULT, REFERRER, ts));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeReferral({ vaultAddress: VAULT, referrer: otherReferrer, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /invalid signature|not this vault's owner/,
  );
});

test("authorizeReferral rejects when the signer is not the vault's on-chain owner", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildReferralMessage(VAULT, REFERRER, ts));
  const someoneElse = Wallet.createRandom();
  const readOwner = fakeReader(someoneElse.address);
  await assert.rejects(
    authorizeReferral({ vaultAddress: VAULT, referrer: REFERRER, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /not this vault's owner/,
  );
});

test("authorizeReferral rejects an expired timestamp without ever calling the chain reader", async () => {
  const staleTs = Date.now() - 10 * 60 * 1000;
  const signature = await wallet.signMessage(buildReferralMessage(VAULT, REFERRER, staleTs));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeReferral({ vaultAddress: VAULT, referrer: REFERRER, timestampMs: staleTs, signature, rpcUrl: "unused", readOwner }),
    /expired/,
  );
  assert.equal(readOwner.calls.length, 0);
});
