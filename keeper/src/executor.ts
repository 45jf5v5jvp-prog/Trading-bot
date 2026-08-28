import { Contract, formatEther, formatUnits, parseEther } from "ethers";
import { CFG } from "./config.js";
import { keeper, provider, routerRead, txQueue, tradeRateLimiter, gasOk, type Dyn } from "./chain.js";
import { VAULT_ABI } from "./abis.js";
import { db } from "./db.js";
import { log } from "./log.js";

export interface SwapRequest {
  vault: string;
  bot: "launch" | "trading" | "snipe" | "limit" | "discovery" | "hunter" | "ask" | "deposit";
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
/**
 * The real price-per-gas-unit this trade will actually bid on chain - used
 * both for the vault's gas REIMBURSEMENT estimate below and, critically,
 * passed as the literal gasPrice override on the transaction itself further
 * down in executeSwap. Those used to be two disconnected things: this
 * function only ever fed the reimbursement math, while the real send had no
 * gasPrice override at all and was left to ethers' own default - so raising
 * this number used to change what the vault got charged without changing
 * what the transaction actually bid to get mined, a real bug found while
 * chasing a live incident (see below).
 *
 * Launch buys bid harder still. During a spike a transaction that does not
 * outbid simply sits in the mempool, and for a sniper that is the same as
 * not trading.
 *
 * The non-urgent tier (everything else - Hunter/Rules/Discovery/Snipe buys
 * AND every position exit, tp/sl/AI/owner-requested alike) used to bid only
 * 115% over the base reading. Confirmed live 2026-08-27/28: at 115%
 * headroom, every exit attempt across several different Hunter positions
 * (the AI explicitly recommending "take the win" each time) submitted a
 * transaction that then sat unconfirmed for the full 2-minute wait timeout,
 * tick after tick, for hours - nothing was structurally broken, the bid
 * just wasn't competitive enough to get mined, and (see the bug above)
 * raising the reimbursement estimate alone would never have fixed that,
 * since it never touched the real transaction's price. Raised to 200%
 * (double the base reading) on the owner's explicit call: pay more for the
 * certainty of a fast confirmation over minimizing gas spend - an
 * unconfirmed exit sitting for hours is a worse outcome than overpaying gas
 * on trades sized in the tens of thousands of PLS.
 */
async function boostedGasPrice(urgent: boolean): Promise<bigint> {
  const fee = await provider.getFeeData();
  const gp = fee.gasPrice ?? 0n;
  const headroom = urgent ? 250n : 200n;
  return (gp * headroom) / 100n;
}

// Confirmed live 2026-08-26: a submitted transaction that never gets mined
// (dropped, stuck in an underpriced mempool, an RPC that stops reporting
// confirmations) left tx.wait() below waiting forever, with no default
// timeout of its own. txQueue is a single serialized chain SHARED across
// every vault and every bot (see chain.ts's own comment) - one stuck wait
// therefore blocks every other trade in the entire keeper behind it,
// permanently, not just the one that got stuck. Symptom in the logs: the
// health loop's queue=N (txQueue.pending) sitting frozen for hours while
// open/fires24h never move, across every vault at once. Ethers' own
// wait(confirms, timeoutMs) already supports exactly this - no custom
// wrapper needed, unlike the plain-fetch hangs fixed in httpTimeout.ts.
// Giving up here does not cancel the broadcast transaction; it may still
// confirm later on its own. That's an accepted tradeoff over blocking the
// whole queue forever - a retried close on the next tick just attempts a
// fresh executeSwap, which safely no-ops/fails if the original already
// sold the position's tokens by the time it lands.
const TX_WAIT_TIMEOUT_MS = 120_000;

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

  // Sanity-check the RPC's own gas price reading before it can influence
  // anything downstream. A single bad read here (seen in production: a
  // reading that implied roughly 10 million gwei, three times above this
  // cap) otherwise flows straight into the share-of-trade check below,
  // which positions.ts treats as a STRUCTURAL failure - permanently
  // retiring an otherwise-sellable position after only 5 retries (about
  // 100 seconds at the default check interval). Catching it here instead
  // returns "gas price above cap", which positions.ts correctly treats as
  // transient and keeps retrying forever. Applies in dry run too so a bad
  // reading shows up in logs rather than only in a live trade.
  if (!(await gasOk())) return { ok: false, amountOut: 0n, reason: "gas price above cap" };

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
  // WPLS, which covers every buy. On a sell the vault caps it anyway. Same
  // boosted price the real transaction below actually bids with - see
  // boostedGasPrice's own comment for why those must never be two different
  // numbers.
  const gasPrice = await boostedGasPrice(req.bot === "launch");
  const gasFee = 400_000n * gasPrice;

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

  return txQueue.run(`${req.bot}:${req.vault}`, async () => {
    try {
      const est: bigint = await vault.executeSwap.estimateGas(req.path, req.amountIn, minOut, gasFee);
      // gasPrice here is the fix - previously omitted entirely, leaving the
      // real transaction's bid up to ethers' own default rather than the
      // boosted price computed above, which is the root cause this comment
      // block on boostedGasPrice explains.
      const tx = await vault.executeSwap(req.path, req.amountIn, minOut, gasFee, {
        gasLimit: (est * 130n) / 100n,
        gasPrice,
      });
      const rc = await tx.wait(1, TX_WAIT_TIMEOUT_MS);

      // `quoted` is a pre-trade estimate - on a sell the contract deducts the
      // platform fee AND gas reimbursement from it afterward (BotVault.sol's
      // executeSwap, non-payingIn branch), which this quote never accounted
      // for, so it always overstates what the vault actually kept. The
      // Traded event is the contract's own record of both the real proceeds
      // AND the real fee - read it instead of trusting an estimate, so
      // whatever calls this (proceeds_pls on a sell, tokensOut/entry_price
      // on a buy, and the fires row logged below) reflects what actually
      // happened, not what was predicted.
      let realAmountOut = quoted;
      let realFeeWei: bigint | null = null;
      try {
        for (const entry of rc?.logs ?? []) {
          if (entry.address.toLowerCase() !== req.vault.toLowerCase()) continue;
          const parsed = vault.interface.parseLog(entry);
          if (parsed?.name === "Traded") {
            realAmountOut = parsed.args.amountOut as bigint;
            realFeeWei = parsed.args.fee as bigint; // always WPLS-denominated on both sides - see BotVault.sol
            break;
          }
        }
      } catch (e) {
        log("warn", "exec", `Could not read the real Traded amount for ${tx.hash}, using the pre-trade estimate: ${(e as Error).message}`);
      }

      // req.amountIn is WPLS (18 decimals, always) on a buy, but the risky
      // token being sold - decimals unknown, HEX is 8, plenty are 6 or 9 -
      // on a sell. formatEther always assumes 18, which is exactly the bug
      // that skewed entry_price before (see positions.ts's openPosition):
      // same fix here, look up the real decimals rather than assume them.
      const isWplsIn = req.path[0]!.toLowerCase() === CFG.wpls.toLowerCase();
      const inDecimals = isWplsIn ? 18 : (db.prepare("SELECT decimals FROM watched WHERE token = ?")
        .get(req.path[0]!.toLowerCase()) as { decimals: number } | undefined)?.decimals ?? 18;
      const amountLogged = Number(formatUnits(req.amountIn, inDecimals));
      const feeLogged = realFeeWei !== null
        ? Number(formatEther(realFeeWei))
        : amountLogged * (CFG.feeBps / 10_000); // pre-trade fallback if the event couldn't be read
      const side = isWplsIn ? "buy" : "sell";
      db.prepare(`INSERT INTO fires(vault,bot,token,ts,amount,fee,tx_hash,side) VALUES(?,?,?,?,?,?,?,?)`)
        .run(req.vault.toLowerCase(), req.bot, req.tokenLabel, now, amountLogged, feeLogged, tx.hash, side);
      log("info", "exec", `${req.bot} filled ${req.tokenLabel} tx=${tx.hash} block=${rc?.blockNumber}`);
      return { ok: true, amountOut: realAmountOut, txHash: tx.hash };
    } catch (e) {
      log("error", "exec", `Swap failed on ${req.vault}: ${(e as Error).message.slice(0, 160)}`);
      return { ok: false, amountOut: 0n, reason: (e as Error).message.slice(0, 160) };
    }
  });
}

// --- Real-cost-aware valuation for open-position decisions ---------------

// maxGasFeeBps rarely changes for a given vault (an owner setting, not
// per-trade), so it's cheap to cache for a while rather than re-read it on
// every position-check tick for every open position.
const maxGasFeeBpsCache = new Map<string, { bps: number; at: number }>();
const MAX_GAS_FEE_BPS_TTL_MS = 10 * 60 * 1000;

async function cachedMaxGasFeeBps(vaultAddr: string): Promise<number> {
  const key = vaultAddr.toLowerCase();
  const cached = maxGasFeeBpsCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < MAX_GAS_FEE_BPS_TTL_MS) return cached.bps;
  const vault = new Contract(vaultAddr, VAULT_ABI, provider) as Dyn;
  const bps = Number(await vault.maxGasFeeBps());
  maxGasFeeBpsCache.set(key, { bps, at: now });
  return bps;
}

// Gas price moves slowly enough that re-fetching it fresh for every open
// position on every check tick (positions.ts's markToMarket runs this once
// per position) would just be needless RPC load - a short TTL keeps this
// close to live without that cost. Kept separate from boostedGasPrice's own
// fresh-every-call read above, which backs the real trade path and should
// stay as accurate as possible right before broadcasting.
let cachedGasPriceWei: { value: bigint; at: number } | null = null;
const GAS_PRICE_TTL_MS = 30_000;

async function cachedGasPrice(): Promise<bigint> {
  const now = Date.now();
  if (cachedGasPriceWei && now - cachedGasPriceWei.at < GAS_PRICE_TTL_MS) return cachedGasPriceWei.value;
  const fee = await provider.getFeeData();
  const value = fee.gasPrice ?? 0n;
  cachedGasPriceWei = { value, at: now };
  return value;
}

/**
 * What a real close of this position would actually keep, in PLS, after the
 * two charges every real exit pays (see BotVault.sol's executeSwap,
 * non-payingIn branch): the platform fee, and gas reimbursement capped at
 * the vault's own maxGasFeeBps(). A raw AMM quote - even one already
 * discounted for transfer tax - says what the market would give for the
 * tokens; it says nothing about what the vault keeps once those two charges
 * come out of that on the way out. Every place that reads a position's
 * current value to decide whether to exit (the plain take-profit/stop-loss/
 * trailing/time ratio check, Hunter Auto Full's AI exit judgment, the
 * holding-cap check) was comparing a cost-free number against the entry
 * cost - so a position sitting at "roughly flat" by that comparison was
 * already a small guaranteed loss the moment it was actually sold. Uses the
 * same non-urgent gas estimate a patient (non-launch) real exit would.
 */
export async function netOfExitCosts(rawValuePls: number, vaultAddr: string): Promise<number> {
  if (rawValuePls <= 0) return rawValuePls;
  const [gasPrice, maxGasFeeBps] = await Promise.all([cachedGasPrice(), cachedMaxGasFeeBps(vaultAddr)]);
  const gasFeePls = Number(formatEther((400_000n * gasPrice * 115n) / 100n));
  const gasFeeCappedPls = Math.min(gasFeePls, (rawValuePls * maxGasFeeBps) / 10_000);
  const feePls = (rawValuePls * CFG.feeBps) / 10_000;
  return Math.max(0, rawValuePls - feePls - gasFeeCappedPls);
}

export { parseEther, formatEther, provider };
