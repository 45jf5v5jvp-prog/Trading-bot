import { Contract, formatEther, parseEther } from "ethers";
import { CFG } from "./config.js";
import { keeper, provider, routerRead, txQueue, tradeRateLimiter, gasOk, type Dyn } from "./chain.js";
import { VAULT_ABI } from "./abis.js";
import { db } from "./db.js";
import { log } from "./log.js";

export interface SwapRequest {
  vault: string;
  bot: "launch" | "trading" | "snipe" | "limit";
  path: string[];
  amountIn: bigint;
  tokenLabel: string;
  slippageBps?: number;
}

/**
 * The keeper signs the transaction, so the keeper pays the gas. On PulseChain a
 * vault swap runs roughly 300 to 500 PLS. A 0.15% fee on a 25,000 PLS trade
 * earns 38 PLS, so without reimbursement the operator loses money on every
 * small trade and loses more as adoption grows.
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
  const isSell = inToken !== CFG.wpls.toLowerCase();
  const taxBps = taxRow ? (isSell ? taxRow.sell_tax_bps : taxRow.buy_tax_bps) : 0;
  if (taxBps > 0)
    log("debug", "exec", `Discounting quote by measured ${taxBps} bps tax on ${req.tokenLabel}`);

  const afterTax = (quoted * BigInt(10_000 - Math.min(taxBps, 5000))) / 10_000n;
  const slip = req.slippageBps ?? CFG.maxSlippageBps;
  const minOut = (afterTax * BigInt(10_000 - slip)) / 10_000n;
  if (minOut === 0n) return { ok: false, amountOut: 0n, reason: "computed floor is zero" };

  // Gas reimbursement, priced in the input token. Only exact when the input is
  // WPLS, which covers every buy. On a sell the vault caps it anyway.
  const gasFee = await estimateGasFee(400_000n, req.bot === "launch");

  // The vault enforces the owner's gas ceilings, but failing here first saves a
  // pointless RPC round trip and gives a readable reason in the log.
  const [ceiling, shareBps] = await Promise.all([vault.maxGasFee(), vault.maxGasFeeBps()]);
  if (gasFee > BigInt(ceiling))
    return { ok: false, amountOut: 0n,
      reason: `gas is ${formatEther(gasFee)} PLS, above their ceiling. Skipped rather than overpaid.` };

  // The share-of-trade check only makes sense against the WPLS side. Buying,
  // that's the input. Selling, it's the expected proceeds. Comparing a gas
  // figure in PLS to an amount denominated in some other token is nonsense.
  const isBuy = req.path[0]!.toLowerCase() === CFG.wpls.toLowerCase();
  const plsSide = isBuy ? req.amountIn : quoted;
  if (gasFee > (plsSide * BigInt(shareBps)) / 10_000n)
    return { ok: false, amountOut: 0n,
      reason: `gas is ${formatEther(gasFee)} PLS, over their share-of-trade limit for a ${formatEther(plsSide)} PLS trade. Skipped.` };

  try {
    await vault.executeSwap.staticCall(req.path, req.amountIn, minOut, gasFee);
  } catch (e) {
    return { ok: false, amountOut: 0n, reason: `would revert: ${(e as Error).message.slice(0, 140)}` };
  }

  if (CFG.dryRun) {
    log("info", "exec", `DRY RUN ${req.bot} ${req.tokenLabel} in=${formatEther(req.amountIn)} PLS ` +
      `minOut=${minOut} gasFee=${formatEther(gasFee)} PLS`);
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

export { parseEther, formatEther, provider };
