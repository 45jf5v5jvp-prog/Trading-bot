import { Contract, JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import { CFG } from "./config.js";
import { ROUTER_ABI, FACTORY_ABI } from "./abis.js";
import { RateLimiter } from "./concurrency.js";
import { log } from "./log.js";

export type Dyn = Contract & Record<string, any>;

export const provider = new JsonRpcProvider(CFG.rpcUrl, { chainId: CFG.chainId, name: "pulsechain" });
export const keeper: Wallet | null = CFG.keeperKey ? new Wallet(CFG.keeperKey, provider) : null;

export const router = new Contract(CFG.router, ROUTER_ABI, keeper ?? provider) as Dyn;
export const routerRead = new Contract(CFG.router, ROUTER_ABI, provider) as Dyn;
export const factory = new Contract(CFG.factory, FACTORY_ABI, provider) as Dyn;

export async function verifyChain(): Promise<void> {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CFG.chainId)
    throw new Error(`RPC is chain ${net.chainId}, expected ${CFG.chainId}`);
  const f: string = await routerRead.factory();
  if (f.toLowerCase() !== CFG.factory.toLowerCase())
    throw new Error(`Router reports factory ${f}, config has ${CFG.factory}`);
  log("info", "chain", `Connected to PulseChain, router and factory agree`);
}

export async function gasOk(): Promise<boolean> {
  const fee = await provider.getFeeData();
  const gp = fee.gasPrice ?? 0n;
  const cap = parseUnits(String(CFG.maxGasPriceGwei), "gwei");
  if (gp > cap) {
    log("warn", "chain", `Gas ${formatUnits(gp, "gwei")} gwei above cap ${CFG.maxGasPriceGwei}`);
    return false;
  }
  return true;
}

/**
 * Serialised transaction queue.
 *
 * The keeper may fire several vault swaps in the same second. Sending them
 * concurrently from one key produces nonce collisions and silently dropped
 * transactions, which look like the bot "just not firing". Everything goes
 * through here, one at a time, in order.
 */
class TxQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private depth = 0;

  run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.depth++;
    const next = this.chain.then(async () => {
      try {
        return await fn();
      } finally {
        this.depth--;
      }
    });
    this.chain = next.catch(() => undefined);
    if (this.depth > 25) log("warn", "queue", `Backlog is ${this.depth} deep`);
    return next as Promise<T>;
  }

  get pending(): number { return this.depth; }
}

export const txQueue = new TxQueue();

/**
 * Global backstop on how many real trades the keeper submits per minute,
 * across every vault combined. Not a throttle on normal use - it is sized far
 * above what legitimate rule-based trading should ever hit. Its only job is to
 * cap the damage if something goes wrong (a cooldown bug, a rule re-firing).
 * See executor.ts for where this is checked.
 */
export const tradeRateLimiter = new RateLimiter(CFG.maxTradesPerMinute, 60_000);

export { formatUnits, parseUnits };
