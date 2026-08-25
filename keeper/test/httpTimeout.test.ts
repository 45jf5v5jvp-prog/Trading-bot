import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout } from "../src/httpTimeout.js";

function mockFetch(impl: typeof globalThis.fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test("fetchWithTimeout resolves normally when the request finishes in time", async () => {
  const restore = mockFetch(async () => new Response("ok"));
  try {
    const res = await fetchWithTimeout("https://example.test", {}, 1000);
    assert.equal(await res.text(), "ok");
  } finally { restore(); }
});

// The bug this whole module exists to fix: a request that never settles used
// to hang the caller (and, transitively, the whole keeper loop that awaited
// it - see httpTimeout.ts's own comment) forever, with nothing to catch or
// time-bound it. This mock behaves like a real, spec-compliant fetch: it
// only ever settles when its OWN passed signal aborts (never on its own) -
// proving both that fetchWithTimeout rejects instead of hanging AND that it
// actually triggered the abort (a Promise.race that just stopped awaiting
// while the real request kept running in the background would leave this
// mock's promise dangling forever and hang the test itself, the same way
// the flawed first draft of this test did). A short ms here (well under the
// file's real 8s/30s defaults) keeps this test fast.
test("fetchWithTimeout rejects instead of hanging forever, by actually aborting the request", async () => {
  let sawAbort = false;
  const restore = mockFetch((_url, init) => {
    const signal = (init as RequestInit).signal!;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("The operation was aborted")); });
    });
  });
  try {
    await assert.rejects(fetchWithTimeout("https://example.test", {}, 50));
    assert.equal(sawAbort, true);
  } finally { restore(); }
});

test("fetchWithTimeout passes through the caller's own init options (method, body, headers)", async () => {
  let captured: RequestInit | undefined;
  const restore = mockFetch(async (_url, init) => {
    captured = init as RequestInit;
    return new Response("ok");
  });
  try {
    await fetchWithTimeout("https://example.test", { method: "POST", body: "hello", headers: { "x-test": "1" } }, 1000);
    assert.equal(captured?.method, "POST");
    assert.equal(captured?.body, "hello");
    assert.equal((captured?.headers as Record<string, string>)["x-test"], "1");
  } finally { restore(); }
});
