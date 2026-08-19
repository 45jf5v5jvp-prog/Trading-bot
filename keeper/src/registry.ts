import { Contract } from "ethers";
import { CFG } from "./config.js";
import { provider, type Dyn } from "./chain.js";
import { VAULT_ABI, VAULT_FACTORY_ABI } from "./abis.js";
import { mapLimit } from "./concurrency.js";
import { log } from "./log.js";

/**
 * Bot configuration lives off chain. The vault holds funds and enforces hard
 * limits (max trade size, cooldown, executor identity); the settings a user
 * picks in the app live here. Keep it that way: putting rule parameters on
 * chain means a gas fee every time someone drags a slider.
 */
export interface LaunchConfig {
  enabled: boolean;
  perLaunchPls: number;
  maxPerDay: number;
  takeProfitPct: number;
  stopLossPct: number;       // 0 disables
  trailingStopPct: number;   // 0 disables. Sells when price falls this % off its peak.
  timeExitMin: number;       // 0 disables
  maxBuyTaxBps: number;
  maxSellTaxBps: number;
  requireLpLock: boolean;
  maxDeployerPct: number;
  minLiquidityPls: number;
  // Off by default so this never silently changes behavior for an existing
  // saved config - a user has to opt in. See screener.ts's checkOwnerRenounced
  // for why this exists: an unrenounced owner is the most common way a token
  // keeps a backdoor to drain a holder after a normal buy/sell probe already
  // passed.
  requireOwnerRenounced: boolean;
}

export interface TradingRule {
  enabled: boolean;
  token: string;
  direction: "drops" | "rises";
  thresholdPct: number;
  lookbackHours: number;
  allocPct: number;
  cooldownHours: number;
  maxFires: number;
  // Sell side. Each buy this rule makes opens (or averages into) a position that
  // carries these exits. 0 or omitted disables that particular exit.
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  timeExitMin?: number;
}

export interface VaultRecord {
  address: string;
  owner: string;
  paused: boolean;
  executorOk: boolean;
  launch: LaunchConfig;
  rules: TradingRule[];
  // Never let one token exceed this share of the vault's value. The single most
  // important safety setting: without it a dip-buying rule tips the whole vault
  // into one falling token. 0 disables (not recommended).
  maxHoldingPct: number;
  // "v2": BotVault, only ever trades through the V2 router (executeSwap).
  // "multiVenue": MultiVenueVault, can trade V2 or V3 (executeSwapV2/V3) -
  // see contracts/MultiVenueVault.sol. Existing vaults are permanently one
  // kind or the other; a clone can never change which implementation it
  // points at. executor.ts dispatches on this field.
  kind: "v2" | "multiVenue";
}

/** Default holding cap when a config does not specify one. */
export const DEFAULT_MAX_HOLDING_PCT = 40;

const DEFAULT_LAUNCH: LaunchConfig = {
  enabled: false, perLaunchPls: 0, maxPerDay: 4, takeProfitPct: 50, stopLossPct: 35,
  trailingStopPct: 0, timeExitMin: 30, maxBuyTaxBps: 1000, maxSellTaxBps: 1000,
  requireLpLock: true, maxDeployerPct: 15, minLiquidityPls: 2_000_000,
  requireOwnerRenounced: false,
};

const cache = new Map<string, VaultRecord>();

interface RawConfig { launch?: Partial<LaunchConfig>; rules?: TradingRule[]; maxHoldingPct?: number }
type LoadedConfig = { launch: LaunchConfig; rules: TradingRule[]; maxHoldingPct: number };

const EMPTY: LoadedConfig = {
  launch: { ...DEFAULT_LAUNCH }, rules: [], maxHoldingPct: DEFAULT_MAX_HOLDING_PCT,
};

function shape(raw: RawConfig): LoadedConfig {
  return {
    launch: { ...DEFAULT_LAUNCH, ...(raw.launch ?? {}) },
    rules: (raw.rules ?? []).filter((r) => r.enabled),
    maxHoldingPct: raw.maxHoldingPct ?? DEFAULT_MAX_HOLDING_PCT,
  };
}

/**
 * Where a vault's bot settings come from. Two sources, checked in order:
 *
 *   1. CONFIG_API  - the web backend bots.icaria.pro will serve. Used in
 *      production once it exists.
 *   2. CONFIG_FILE - a local JSON file (default ./config.json). This is how you
 *      run your own bots today, before the web backend is built. Shape:
 *        { "defaults": { launch, rules, maxHoldingPct },
 *          "vaults": { "0xvault": { launch, rules, maxHoldingPct } } }
 *      A vault uses its own entry if present, otherwise "defaults", otherwise
 *      an empty (do-nothing) config.
 *
 * Either way the keeper is agnostic: it only sees the shaped result.
 */
async function loadConfig(vault: string): Promise<LoadedConfig> {
  const api = process.env.CONFIG_API;
  if (api) {
    try {
      const res = await fetch(`${api}/vaults/${vault}/config`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return shape((await res.json()) as RawConfig);
    } catch (e) {
      log("warn", "registry", `Config API failed for ${vault}: ${(e as Error).message}`);
      return EMPTY;
    }
  }

  const file = process.env.CONFIG_FILE || "./config.json";
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      defaults?: RawConfig; vaults?: Record<string, RawConfig>;
    };
    const forVault = parsed.vaults?.[vault.toLowerCase()] ?? parsed.vaults?.[vault];
    const raw = forVault ?? parsed.defaults;
    if (!raw) return EMPTY;
    return shape(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      log("warn", "registry", `Config file ${file} unreadable: ${(e as Error).message}`);
    return EMPTY;
  }
}

/** Every vault address a factory has ever created, via its allVaults/vaultCount getters. */
async function vaultsOf(factoryAddress: string): Promise<string[]> {
  const f = new Contract(factoryAddress, VAULT_FACTORY_ABI, provider) as Dyn;
  const count = Number(await f.vaultCount());
  const indices = Array.from({ length: count }, (_, i) => i);
  const addrResults = await mapLimit(indices, CFG.keeperConcurrency, async (i) => {
    try { return await f.allVaults(i) as string; } catch { return null; }
  });
  return addrResults.filter((a): a is string => a !== null);
}

/**
 * Fetches and refreshes every vault's on-chain state and config, from both
 * the V2-only VaultFactory and (if configured) the MultiVenueVaultFactory.
 * Runs a bounded number of vaults concurrently (KEEPER_CONCURRENCY) rather
 * than one at a time, so this pass stays well within its own polling
 * interval as the vault count grows.
 */
export async function refresh(): Promise<VaultRecord[]> {
  const v2Addrs = await vaultsOf(CFG.vaultFactory);
  // Multi-venue support is opt-in - an unset factory address just means
  // "no multi-venue vaults exist yet," not an error.
  const multiVenueAddrs = CFG.multiVenueVaultFactory ? await vaultsOf(CFG.multiVenueVaultFactory) : [];

  const tagged: { addr: string; kind: "v2" | "multiVenue" }[] = [
    ...v2Addrs.map((addr) => ({ addr, kind: "v2" as const })),
    ...multiVenueAddrs.map((addr) => ({ addr, kind: "multiVenue" as const })),
  ];

  const recs = await mapLimit(tagged, CFG.keeperConcurrency, async ({ addr, kind }) => {
    const v = new Contract(addr, VAULT_ABI, provider) as Dyn;
    try {
      const [owner, executor, paused] = await Promise.all([v.owner(), v.executor(), v.paused()]);
      const executorOk =
        String(executor).toLowerCase() === (process.env.KEEPER_ADDRESS || "").toLowerCase();
      const { launch, rules, maxHoldingPct } = await loadConfig(addr);
      const rec: VaultRecord = { address: addr, owner, paused, executorOk, launch, rules, maxHoldingPct, kind };
      cache.set(addr.toLowerCase(), rec);
      return rec;
    } catch (e) {
      log("warn", "registry", `Skipping vault ${addr}: ${(e as Error).message}`);
      return null;
    }
  });

  const out = recs.filter((r): r is VaultRecord => r !== null);
  const active = out.filter((v) => v.executorOk && !v.paused);
  log("info", "registry", `${out.length} vaults, ${active.length} active`);
  return out;
}

export const registry = {
  all: (): VaultRecord[] => [...cache.values()],
  active: (): VaultRecord[] => [...cache.values()].filter((v) => v.executorOk && !v.paused),
  get: (a: string): VaultRecord | undefined => cache.get(a.toLowerCase()),
};
