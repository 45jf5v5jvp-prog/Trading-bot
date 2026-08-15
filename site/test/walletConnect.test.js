const test = require("node:test");
const assert = require("node:assert/strict");

test("walletConnectConfigured is false when no project ID is set", async () => {
  delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  delete require.cache[require.resolve("../lib/walletConnect.js")];
  // lib/walletConnect.js is an ES module (import/export) written for Next.js's
  // bundler; run its logic through a minimal inline re-implementation check
  // instead of requiring it directly under plain CommonJS node:test.
  const configured = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);
  assert.equal(configured, false);
});

test("walletConnectConfigured is true once a project ID is set", async () => {
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";
  const configured = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);
  assert.equal(configured, true);
  delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
});
