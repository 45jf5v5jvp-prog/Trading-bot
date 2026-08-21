const test = require("node:test");
const assert = require("node:assert/strict");
const { Wallet, id } = require("ethers");
const { authorizeConfigWrite, authorizeClose, authorizeBuyOpportunity, authorizeHunterChat, buildMessage, buildCloseMessage, buildBuyOpportunityMessage, buildHunterChatMessage } = require("../lib/auth");

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
  const signature = await wallet.signMessage(buildBuyOpportunityMessage(VAULT, 7, ts));
  const readOwner = fakeReader(wallet.address);
  const result = await authorizeBuyOpportunity({ vaultAddress: VAULT, opportunityId: 7, timestampMs: ts, signature, rpcUrl: "unused", readOwner });
  assert.equal(result.signer.toLowerCase(), wallet.address.toLowerCase());
});

test("authorizeBuyOpportunity rejects a signature made for a DIFFERENT opportunity id", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildBuyOpportunityMessage(VAULT, 7, ts));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeBuyOpportunity({ vaultAddress: VAULT, opportunityId: 8, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /not this vault's owner/,
  );
});

test("authorizeBuyOpportunity rejects an expired timestamp without ever calling the chain reader", async () => {
  const staleTs = Date.now() - 10 * 60 * 1000;
  const signature = await wallet.signMessage(buildBuyOpportunityMessage(VAULT, 7, staleTs));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeBuyOpportunity({ vaultAddress: VAULT, opportunityId: 7, timestampMs: staleTs, signature, rpcUrl: "unused", readOwner }),
    /expired/,
  );
  assert.equal(readOwner.calls.length, 0);
});

test("authorizeHunterChat accepts a correctly-signed chat message from the real owner", async () => {
  const ts = Date.now();
  const hash = id("Don't buy anything with liquidity under 5,000,000 ETH");
  const signature = await wallet.signMessage(buildHunterChatMessage(VAULT, hash, ts));
  const readOwner = fakeReader(wallet.address);
  const result = await authorizeHunterChat({ vaultAddress: VAULT, textHash: hash, timestampMs: ts, signature, rpcUrl: "unused", readOwner });
  assert.equal(result.signer.toLowerCase(), wallet.address.toLowerCase());
});

test("authorizeHunterChat rejects a signature made for DIFFERENT message text (can't retarget a captured signature)", async () => {
  const ts = Date.now();
  const signature = await wallet.signMessage(buildHunterChatMessage(VAULT, id("original message"), ts));
  const readOwner = fakeReader(wallet.address);
  await assert.rejects(
    authorizeHunterChat({ vaultAddress: VAULT, textHash: id("swapped-in message"), timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /invalid signature|not this vault's owner/,
  );
});

test("authorizeHunterChat rejects when the signer is not the vault's on-chain owner", async () => {
  const ts = Date.now();
  const hash = id("chat message text");
  const signature = await wallet.signMessage(buildHunterChatMessage(VAULT, hash, ts));
  const someoneElse = Wallet.createRandom();
  const readOwner = fakeReader(someoneElse.address);
  await assert.rejects(
    authorizeHunterChat({ vaultAddress: VAULT, textHash: hash, timestampMs: ts, signature, rpcUrl: "unused", readOwner }),
    /not this vault's owner/,
  );
});
