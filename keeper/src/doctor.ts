import { Contract, formatEther } from "ethers";
import { CFG } from "./config.js";
import { provider, keeper, verifyChain, routerRead, type Dyn } from "./chain.js";
import { VAULT_FACTORY_ABI, VAULT_ABI } from "./abis.js";
import { db } from "./db.js";

/** Run before every deploy. Catches the setup mistakes that look like bugs later. */
async function doctor(): Promise<void> {
  const problems: string[] = [];
  const ok = (s: string) => console.log(`  ok    ${s}`);
  const bad = (s: string) => { console.log(`  FAIL  ${s}`); problems.push(s); };

  console.log("\nIcaria keeper preflight\n");

  try { await verifyChain(); ok("RPC reachable, router and factory agree"); }
  catch (e) { bad((e as Error).message); }

  if (!keeper) bad("KEEPER_PRIVATE_KEY not set");
  else {
    const bal = await provider.getBalance(keeper.address);
    ok(`Keeper ${keeper.address}`);
    if (bal === 0n) bad("Keeper holds no ETH for gas");
    else ok(`Gas balance ${formatEther(bal)} ETH`);
  }

  if (CFG.treasury === "0x0000000000000000000000000000000000000000")
    bad("TREASURY is the zero address, your 0.25% would be burned");
  else ok(`Treasury ${CFG.treasury}`);

  if (CFG.vaultFactory === "0x0000000000000000000000000000000000000000") bad("VAULT_FACTORY unset");
  else {
    try {
      const f = new Contract(CFG.vaultFactory, VAULT_FACTORY_ABI, provider) as Dyn;
      const n = Number(await f.vaultCount());
      ok(`Vault factory reachable, ${n} vaults deployed`);
      if (n > 0 && keeper) {
        const v = new Contract(await f.allVaults(0), VAULT_ABI, provider) as Dyn;
        const ex: string = await v.executor();
        if (ex.toLowerCase() === keeper.address.toLowerCase())
          ok("First vault has this keeper as executor");
        else bad(`First vault's executor is ${ex}, not this keeper`);
      }
    } catch (e) { bad(`Vault factory unreadable: ${(e as Error).message}`); }
  }

  const probe = process.env.PROBE_ADDRESS;
  if (!probe) bad("PROBE_ADDRESS unset. Launch Bot cannot screen and will reject everything.");
  else {
    const code = await provider.getCode(probe);
    if (code === "0x") bad(`No contract at PROBE_ADDRESS ${probe}`);
    else ok(`SwapProbe deployed at ${probe}`);
  }

  try {
    // USDG (docs.robinhood.com/chain/contracts) as the reference pair - any
    // liquid stablecoin/WETH pool proves the router itself is reachable and
    // wired to the right factory. Not a claim that this specific pool exists
    // or is deep; if this fails, check that assumption before anything else.
    const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    // Not formatting the raw amount as a token quantity here - USDG's
    // decimals aren't confirmed, and this check only needs to prove the
    // router/factory answer at all, not print a correctly-scaled number.
    const amounts: bigint[] = await routerRead.getAmountsOut(10n ** 18n, [CFG.weth, usdg]);
    ok(`Router quotes fine, WETH/USDG pool answers (raw: ${amounts[1]!})`);
  } catch (e) { bad(`Router quote failed: ${(e as Error).message}`); }

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  ok(`Database ready, ${tables.length} tables at ${CFG.dbPath}`);

  console.log(`\nMode: ${CFG.dryRun ? "DRY RUN" : "*** LIVE ***"}  Fee: ${CFG.feeBps / 100}%\n`);
  if (problems.length) {
    console.log(`${problems.length} problem(s) to fix before going live.\n`);
    process.exit(1);
  }
  console.log("All checks passed.\n");
}

doctor().catch((e) => { console.error(e); process.exit(1); });
