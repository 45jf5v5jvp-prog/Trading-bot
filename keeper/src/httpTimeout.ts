/**
 * Every plain `fetch` call in this codebase used to have no time bound at
 * all - unlike blockchain RPC calls, which have used an explicit timeout
 * wrapper for a long time. Confirmed live 2026-08-25: the keeper's entire
 * positions loop froze for over 10 hours (2026-08-25T02:25 through when a
 * vault owner reported Close All doing nothing) with zero stop-losses,
 * take-profits, or AI exits firing on ANY vault in that window - not a
 * feature-specific bug, the whole exit system was dead. Root cause was
 * positions.ts's fetchCloseRequests: a bare `await fetch(...)` to the
 * site's CONFIG_API with no timeout at all. loop() in index.ts (the shared
 * "run this every N seconds, never overlapping" wrapper every bot loop
 * uses) guards against a THROWN error just fine, but has no defense against
 * a promise that never settles either way - a `running` flag only resets in
 * a `finally` block, which a hung fetch never reaches. One stuck request
 * anywhere in positions.tick() therefore froze position management for
 * every vault forever, not just the one that triggered it, since tick()
 * awaits every vault's requests before it can finish and let the next pass
 * start.
 *
 * Uses AbortController, not a Promise.race - racing a timeout against a
 * plain fetch still leaves the real underlying request running in the
 * background indefinitely (just no longer awaited), which does not free
 * the actual stuck socket/connection. abort() actually cancels it.
 */
export async function fetchWithTimeout(
  url: string, init: RequestInit = {}, ms = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
