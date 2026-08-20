import { Contract, formatEther, parseEther } from "ethers";
import { CFG } from "./config.js";
import { keeper, provider, routerRead, txQueue, tradeRateLimiter, gasOk, type Dyn } from "./chain.js";
import { VAULT_ABI, MULTI_VENUE_VAULT_ABI, MULTI_VENUE_V4_VAULT_ABI, V3_QUOTER_ABI } from "./abis.js";
import { v4Quote, isBaseCurrency, type V4PoolKey } from "./venues.js";
import { db } from "./db.js";
import { log } from "./log.js";

export interface SwapRequest {
  vault: string;
  bot: "launch" | "trading" | "snipe" | "limit" | "discovery";
  path: string[];
  amountIn: bigint;
  tokenLabel: string;
  slippageBps?: number;
}

/**
 * The keeper signs the transaction, so the keeper pays the gas. Whatever that
 * costs on Robinhood Chain (an Arbitrum Orbit L2 - likely far cheaper than
 * PulseChain's gas market, but not measured here yet), a small percentage fee
 * on a small trade will not cover it without reimbursement. Measure real gas
 * costs after the first live trades and correct any defaults that assume
 * otherwise, the same lesson learned the hard way on the PulseChain bot.
 *
 * So each trade repays its own gas out of the vault, in the input token. The
 * contract caps this absolutely and at 1% of the trade, so an over-claim is
 * bounded no matter what this code does.
 */
async function estimateGasFee(gasUnits: bigint, urgent: boolean): Promise<bigint> {
  const fee = await provider.getFeeData();
  const gp = fee.gasPrice ?? 0n;
  // Launch buys bid harder. During a spike a transaction that does not outbid
  // simply sits in the mempool, and for a sniper that is the same as not
  // trading. Rule trades are patient and take the base estimate.
  const headroom = urgent ? 250n : 115n;
  return (gasUnits * gp * headroom) / 100n;
}

export interface SwapResult {
  ok: boolean;
  amountOut: bigint;
  txHash?: string;
  reason?: string;
}

/**
 * Every swap the keeper performs goes through here.
 *
 * Order of operations matters. We quote, apply the slippage floor, then run
 * a staticCall of the exact transaction we intend to send. If the staticCall
 * reverts, the real one would too, and we have burned no gas finding out.
 */
export async function executeSwap(req: SwapRequest): Promise<SwapResult> {
  if (CFG.globalKill) return { ok: false, amountOut: 0n, reason: "global kill switch on" };
  if (!keeper) return { ok: false, amountOut: 0n, reason: "no keeper key loaded" };

  const vault = new Contract(req.vault, VAULT_ABI, keeper) as Dyn;

  // Respect the on-chain limits the user set, before wasting a call.
  const [paused, maxSize, minInterval, lastAt] = await Promise.all([
    vault.paused(), vault.maxTradeSize(), vault.minInterval(), vault.lastTradeAt(),
  ]);
  if (paused) return { ok: false, amountOut: 0n, reason: "vault paused by owner" };
  if (req.amountIn > BigInt(maxSize))
    return { ok: false, amountOut: 0n, reason: "above owner's max trade size" };
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(lastAt) + Number(minInterval))
    return { ok: false, amountOut: 0n, reason: "vault cooldown active" };

  // Global backstop, checked before the expensive quote/staticCall work below.
  // Sized far above legitimate volume; tripping it means something is wrong
  // (a cooldown not applying, a rule re-firing) and is worth investigating,
  // not routine. Not applied in dry run, which sends nothing and costs nothing.
  if (!CFG.dryRun && !tradeRateLimiter.tryTake()) {
    log("warn", "exec", `Global trade rate limit hit (${CFG.maxTradesPerMinute}/min). ` +
      `Skipping ${req.tokenLabel} for ${req.vault}. If this is legitimate, raise MAX_TRADES_PER_MINUTE.`);
    return { ok: false, amountOut: 0n, reason: "global trade rate limit reached, skipped for safety" };
  }

  // The vault takes our fee off the input before swapping, so quote net of it.
  const afterFee = (req.amountIn * BigInt(10_000 - CFG.feeBps)) / 10_000n;
  let quoted: bigint;
  try {
    const amounts: bigint[] = await routerRead.getAmountsOut(afterFee, req.path);
    quoted = amounts[amounts.length - 1]!;
  } catch (e) {
    return { ok: false, amountOut: 0n, reason: `quote failed: ${(e as Error).message}` };
  }
  if (quoted === 0n) return { ok: false, amountOut: 0n, reason: "quote returned zero" };

  // getAmountsOut is pure reserve arithmetic. It has no idea the token takes a
  // cut on transfer, so `quoted` is always too high for a taxed token. Applying
  // slippage to that inflated figure produces a floor the swap cannot clear,
  // and the vault reverts on its own guard. Discount by the tax the screener
  // actually measured before applying slippage.
  const outToken = req.path[req.path.length - 1]!.toLowerCase();
  const inToken = req.path[0]!.toLowerCase();
  const taxRow = db.prepare(
    "SELECT buy_tax_bps, sell_tax_bps FROM screened WHERE token IN (?, ?)"
  ).get(outToken, inToken) as { buy_tax_bps: number; sell_tax_bps: number } | undefined;

  // Buying: the tax lands on the token arriving. Selling: on the token leaving.
  const isSell = inToken !== CFG.weth.toLowerCase();
  const taxBps = taxRow ? (isSell ? taxRow.sell_tax_bps : taxRow.buy_tax_bps) : 0;
  if (taxBps > 0)
    log("debug", "exec", `Discounting quote by measured ${taxBps} bps tax on ${req.tokenLabel}`);

  const afterTax = (quoted * BigInt(10_000 - Math.min(taxBps, 5000))) / 10_000n;
  const slip = req.slippageBps ?? CFG.maxSlippageBps;
  const minOut = (afterTax * BigInt(10_000 - slip)) / 10_000n;
  if (minOut === 0n) return { ok: false, amountOut: 0n, reason: "computed floor is zero" };

  // Gas reimbursement, priced in the input token. Only exact when the input is
  // WETH, which covers every buy. On a sell the vault caps it anyway.
  const gasFee = await estimateGasFee(400_000n, req.bot === "launch");

  // The vault enforces the owner's gas ceilings, but failing here first saves a
  // pointless RPC round trip and gives a readable reason in the log.
  const [ceiling, shareBps] = await Promise.all([vault.maxGasFee(), vault.maxGasFeeBps()]);
  if (gasFee > BigInt(ceiling))
    return { ok: false, amountOut: 0n,
      reason: `gas is ${formatEther(gasFee)} ETH, above their ceiling. Skipped rather than overpaid.` };

  // The share-of-trade check only makes sense against the WETH side. Buying,
  // that's the input. Selling, it's the expected proceeds. Comparing a gas
  // figure in PLS to an amount denominated in some other token is nonsense.
  const isBuy = req.path[0]!.toLowerCase() === CFG.weth.toLowerCase();
  const plsSide = isBuy ? req.amountIn : quoted;
  if (gasFee > (plsSide * BigInt(shareBps)) / 10_000n)
    return { ok: false, amountOut: 0n,
      reason: `gas is ${formatEther(gasFee)} ETH, over their share-of-trade limit for a ${formatEther(plsSide)} ETH trade. Skipped.` };

  try {
    await vault.executeSwap.staticCall(req.path, req.amountIn, minOut, gasFee);
  } catch (e) {
    return { ok: false, amountOut: 0n, reason: `would revert: ${(e as Error).message.slice(0, 140)}` };
  }

  if (CFG.dryRun) {
    log("info", "exec", `DRY RUN ${req.bot} ${req.tokenLabel} in=${formatEther(req.amountIn)} ETH ` +
      `minOut=${minOut} gasFee=${formatEther(gasFee)} ETH`);
    return { ok: true, amountOut: quoted };
  }
  if (!(await gasOk())) return { ok: false, amountOut: 0n, reason: "gas price above cap" };

  return txQueue.run(`${req.bot}:${req.vault}`, async () => {
    try {
      const est: bigint = await vault.executeSwap.estimateGas(req.path, req.amountIn, minOut, gasFee);
      const tx = await vault.executeSwap(req.path, req.amountIn, minOut, gasFee, {
        gasLimit: (est * 130n) / 100n,
      });
      const rc = await tx.wait();
      const fee = Number(formatEther(req.amountIn)) * (CFG.feeBps / 10_000);
      db.prepare(`INSERT INTO fires(vault,bot,token,ts,amount,fee,tx_hash) VALUES(?,?,?,?,?,?,?)`)
        .run(req.vault.toLowerCase(), req.bot, req.tokenLabel, now,
             Number(formatEther(req.amountIn)), fee, tx.hash);
      log("info", "exec", `${req.bot} filled ${req.tokenLabel} tx=${tx.hash} block=${rc?.blockNumber}`);
      return { ok: true, amountOut: quoted, txHash: tx.hash };
    } catch (e) {
      log("error", "exec", `Swap failed on ${req.vault}: ${(e as Error).message.slice(0, 160)}`);
      return { ok: false, amountOut: 0n, reason: (e as Error).message.slice(0, 160) };
    }
  });
}

// ============================================================================
// Multi-venue execution (MultiVenueVault only - see registry.ts's VaultRecord
// .kind). executeSwap() above is untouched and keeps handling every existing
// V2-only BotVault exactly as it already does - this is new, separate code
// for the new vault type, deliberately not a refactor of the working path.
// ============================================================================

export type TradeVenue =
  | { kind: "v2"; path: string[] }
  | { kind: "v3"; tokenIn: string; tokenOut: string; fee: number }
  // The full PoolKey travels with the trade - V4 has no other way to name a
  // pool. `buy` = spend base for the pool's token; false = sell it back.
  | { kind: "v4"; key: V4PoolKey; buy: boolean };

export interface MultiVenueSwapRequest {
  vault: string;
  bot: "launch" | "trading" | "snipe" | "limit" | "discovery";
  venue: TradeVenue;
  amountIn: bigint;
  tokenLabel: string;
  slippageBps?: number;
}

async function quoteVenue(venue: TradeVenue, amountIn: bigint): Promise<bigint | null> {
  if (venue.kind === "v2") {
    try {
      const amounts: bigint[] = await routerRead.getAmountsOut(amountIn, venue.path);
      return amounts[amounts.length - 1]!;
    } catch { return null; }
  }
  if (venue.kind === "v4") {
    const c0IsBase = isBaseCurrency(venue.key.currency0);
    return v4Quote(venue.key, venue.buy ? c0IsBase : !c0IsBase, amountIn);
  }
  if (!CFG.quoterV3) return null;
  const quoter = new Contract(CFG.quoterV3, V3_QUOTER_ABI, provider) as Dyn;
  try {
    const result = await quoter.quoteExactInputSingle.staticCall(
      venue.tokenIn, venue.tokenOut, venue.fee, amountIn, 0,
    );
    return result[0] as bigint;
  } catch { return null; }
}

/** The traded (non-base) token of a V4 venue - the side that isn't WETH or
 * native ETH. Used for logging and the buy/sell direction checks below. */
function v4Token(key: V4PoolKey): string {
  return isBaseCurrency(key.currency0) ? key.currency1 : key.currency0;
}

export async function executeSwapMultiVenue(req: MultiVenueSwapRequest): Promise<SwapResult> {
  if (CFG.globalKill) return { ok: false, amountOut: 0n, reason: "global kill switch on" };
  if (!keeper) return { ok: false, amountOut: 0n, reason: "no keeper key loaded" };

  // VAULT_ABI covers the fields common to both vault kinds (owner/executor/
  // paused/maxTradeSize/maxGasFee/maxGasFeeBps/minInterval/lastTradeAt);
  // MULTI_VENUE_VAULT_ABI adds the two swap entry points this kind has that
  // the plain VAULT_ABI doesn't.
  const vault = new Contract(req.vault, [...VAULT_ABI, ...MULTI_VENUE_VAULT_ABI, ...MULTI_VENUE_V4_VAULT_ABI], keeper) as Dyn;

  const [paused, maxSize, minInterval, lastAt] = await Promise.all([
    vault.paused(), vault.maxTradeSize(), vault.minInterval(), vault.lastTradeAt(),
  ]);
  if (paused) return { ok: false, amountOut: 0n, reason: "vault paused by owner" };
  if (req.amountIn > BigInt(maxSize))
    return { ok: false, amountOut: 0n, reason: "above owner's max trade size" };
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(lastAt) + Number(minInterval))
    return { ok: false, amountOut: 0n, reason: "vault cooldown active" };

  if (!CFG.dryRun && !tradeRateLimiter.tryTake()) {
    log("warn", "exec", `Global trade rate limit hit (${CFG.maxTradesPerMinute}/min). ` +
      `Skipping ${req.tokenLabel} for ${req.vault}. If this is legitimate, raise MAX_TRADES_PER_MINUTE.`);
    return { ok: false, amountOut: 0n, reason: "global trade rate limit reached, skipped for safety" };
  }

  const afterFee = (req.amountIn * BigInt(10_000 - CFG.feeBps)) / 10_000n;
  const quoted = await quoteVenue(req.venue, afterFee);
  if (quoted === null) return { ok: false, amountOut: 0n, reason: "quote failed" };
  if (quoted === 0n) return { ok: false, amountOut: 0n, reason: "quote returned zero" };

  const tokenIn = req.venue.kind === "v2" ? req.venue.path[0]!
    : req.venue.kind === "v3" ? req.venue.tokenIn
    : req.venue.buy ? CFG.weth : v4Token(req.venue.key);
  const tokenOut = req.venue.kind === "v2" ? req.venue.path[req.venue.path.length - 1]!
    : req.venue.kind === "v3" ? req.venue.tokenOut
    : req.venue.buy ? v4Token(req.venue.key) : CFG.weth;

  // Tax discount only exists for V2 (screen() measures it via SwapProbe's
  // quoted-vs-actual comparison). V3 has no equivalent yet - see
  // SwapProbeV3.sol and screener.ts's screenV3 for why - so this is 0 for a
  // V3 trade and the roundTripLossBps pass/fail gate in screenV3 is the only
  // protection against a taxed/thin V3 pool, not a quote discount here.
  const taxRow = req.venue.kind === "v2" ? db.prepare(
    "SELECT buy_tax_bps, sell_tax_bps FROM screened WHERE token IN (?, ?)"
  ).get(tokenOut.toLowerCase(), tokenIn.toLowerCase()) as { buy_tax_bps: number; sell_tax_bps: number } | undefined : undefined;
  const isSell = tokenIn.toLowerCase() !== CFG.weth.toLowerCase();
  const taxBps = taxRow ? (isSell ? taxRow.sell_tax_bps : taxRow.buy_tax_bps) : 0;
  if (taxBps > 0)
    log("debug", "exec", `Discounting quote by measured ${taxBps} bps tax on ${req.tokenLabel}`);

  const afterTax = (quoted * BigInt(10_000 - Math.min(taxBps, 5000))) / 10_000n;
  const slip = req.slippageBps ?? CFG.maxSlippageBps;
  const minOut = (afterTax * BigInt(10_000 - slip)) / 10_000n;
  if (minOut === 0n) return { ok: false, amountOut: 0n, reason: "computed floor is zero" };

  const gasFee = await estimateGasFee(400_000n, req.bot === "launch");

  const [ceiling, shareBps] = await Promise.all([vault.maxGasFee(), vault.maxGasFeeBps()]);
  if (gasFee > BigInt(ceiling))
    return { ok: false, amountOut: 0n,
      reason: `gas is ${formatEther(gasFee)} ETH, above their ceiling. Skipped rather than overpaid.` };

  const isBuy = tokenIn.toLowerCase() === CFG.weth.toLowerCase();
  const ethSide = isBuy ? req.amountIn : quoted;
  if (gasFee > (ethSide * BigInt(shareBps)) / 10_000n)
    return { ok: false, amountOut: 0n,
      reason: `gas is ${formatEther(gasFee)} ETH, over their share-of-trade limit for a ${formatEther(ethSide)} ETH trade. Skipped.` };

  // Explicit per-venue branches rather than dynamic vault[methodName] lookup
  // on purpose - a dynamically-resolved contract method is easy to get
  // subtly wrong (e.g. calling it before reaching for .staticCall instead of
  // on it), and this is exactly the code path that sends real transactions.
  // Naming both calls out directly, mirroring executeSwap() above, keeps
  // that mistake impossible to make by construction.
  try {
    if (req.venue.kind === "v2") {
      await vault.executeSwapV2.staticCall(req.venue.path, req.amountIn, minOut, gasFee);
    } else if (req.venue.kind === "v3") {
      await vault.executeSwapV3.staticCall(
        req.venue.tokenIn, req.venue.tokenOut, req.venue.fee, req.amountIn, minOut, gasFee,
      );
    } else {
      await vault.executeSwapV4.staticCall(req.venue.key, req.venue.buy, req.amountIn, minOut, gasFee);
    }
  } catch (e) {
    return { ok: false, amountOut: 0n, reason: `would revert: ${(e as Error).message.slice(0, 140)}` };
  }

  if (CFG.dryRun) {
    log("info", "exec", `DRY RUN ${req.bot} ${req.tokenLabel} via ${req.venue.kind} in=${formatEther(req.amountIn)} ETH ` +
      `minOut=${minOut} gasFee=${formatEther(gasFee)} ETH`);
    return { ok: true, amountOut: quoted };
  }
  if (!(await gasOk())) return { ok: false, amountOut: 0n, reason: "gas price above cap" };

  return txQueue.run(`${req.bot}:${req.vault}`, async () => {
    try {
      let tx: { hash: string; wait: () => Promise<{ blockNumber: number } | null> };
      if (req.venue.kind === "v2") {
        const v2 = req.venue;
        const est: bigint = await vault.executeSwapV2.estimateGas(v2.path, req.amountIn, minOut, gasFee);
        tx = await vault.executeSwapV2(v2.path, req.amountIn, minOut, gasFee, { gasLimit: (est * 130n) / 100n });
      } else if (req.venue.kind === "v3") {
        const v3 = req.venue;
        const est: bigint = await vault.executeSwapV3.estimateGas(
          v3.tokenIn, v3.tokenOut, v3.fee, req.amountIn, minOut, gasFee,
        );
        tx = await vault.executeSwapV3(v3.tokenIn, v3.tokenOut, v3.fee, req.amountIn, minOut, gasFee, {
          gasLimit: (est * 130n) / 100n,
        });
      } else {
        const v4 = req.venue;
        const est: bigint = await vault.executeSwapV4.estimateGas(v4.key, v4.buy, req.amountIn, minOut, gasFee);
        tx = await vault.executeSwapV4(v4.key, v4.buy, req.amountIn, minOut, gasFee, {
          gasLimit: (est * 130n) / 100n,
        });
      }
      const rc = await tx.wait();
      const fee = Number(formatEther(req.amountIn)) * (CFG.feeBps / 10_000);
      db.prepare(`INSERT INTO fires(vault,bot,token,ts,amount,fee,tx_hash) VALUES(?,?,?,?,?,?,?)`)
        .run(req.vault.toLowerCase(), req.bot, req.tokenLabel, now,
             Number(formatEther(req.amountIn)), fee, tx.hash);
      log("info", "exec", `${req.bot} filled ${req.tokenLabel} via ${req.venue.kind} tx=${tx.hash} block=${rc?.blockNumber}`);
      return { ok: true, amountOut: quoted, txHash: tx.hash };
    } catch (e) {
      log("error", "exec", `Swap failed on ${req.vault}: ${(e as Error).message.slice(0, 160)}`);
      return { ok: false, amountOut: 0n, reason: (e as Error).message.slice(0, 160) };
    }
  });
}

export { parseEther, formatEther, provider };
