/**
 * Scale helpers. Neither of these makes trades happen faster or more often -
 * they exist so a growing number of vaults doesn't quietly break the keeper.
 *
 * mapLimit: the registry refresh, rule evaluation, and position checks used to
 * loop over vaults one at a time, waiting for each RPC round trip before
 * starting the next. Fine for a handful of vaults; with many, the loop can
 * take longer than its own polling interval and start falling behind. This
 * runs a bounded number of items concurrently instead of unboundedly (which
 * would hammer the RPC endpoint) or strictly one at a time.
 *
 * RateLimiter: a hard ceiling on how many real trades the keeper will submit
 * in a rolling window, across every vault combined. This is a backstop, not a
 * feature: it exists so a bug (a cooldown that fails to apply, a rule that
 * re-fires) or an unlikely coincidence of many rules triggering at once cannot
 * turn into an unbounded burst of transactions. It is deliberately generous by
 * default so it never affects normal use, only a malfunction.
 */

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export class RateLimiter {
  private windowStart: number;
  private count = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStart = this.now();
  }

  /** True if this call is allowed (and counts against the window); false if the cap for this window is already reached. */
  tryTake(): boolean {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count >= this.max) return false;
    this.count++;
    return true;
  }

  /** How many more calls this window will accept right now, without advancing the window. */
  remaining(): number {
    return Math.max(0, this.max - this.count);
  }
}
