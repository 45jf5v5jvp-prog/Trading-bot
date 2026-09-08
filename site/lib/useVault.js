import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatEther, formatUnits, parseEther, parseUnits, ZeroAddress } from "ethers";
import { CHAIN, CHAIN_ID, VAULT_FACTORY, MULTI_VENUE_VAULT_FACTORY, MULTI_VENUE_V4_VAULT_FACTORY, VAULT_FACTORY_ABI, VAULT_ABI, WRAPPED, ERC20_ABI, RPC_URL } from "./contracts";
import { getWalletConnectProvider, walletConnectConfigured } from "./walletConnect";
import { notifyDeposit } from "./depositTokenNotice";

/**
 * Waits for a transaction to confirm by polling our own known-good RPC
 * endpoint, instead of the connected wallet's tx.wait(). Some wallet
 * in-app browsers (seen with Internet Money) never resolve tx.wait()
 * through their injected provider even after the transaction is mined on
 * chain - the promise just hangs forever. That silently stranded users
 * mid-deposit: the approve transaction would confirm fine, but the UI
 * never got past awaiting it to ask for the second (deposit) signature.
 * Polling a plain RPC directly sidesteps whatever the wallet's provider
 * is doing internally.
 *
 * Real bug found live: this used to return the moment ANY receipt existed,
 * never checking receipt.status - a transaction that was mined but REVERTED
 * (wrong wallet for an onlyOwner call, a condition the contract rejected,
 * anything) looked identical to a real success. Every write in this file
 * (deposit, withdraw, setPaused, revokeExecutor, createVault) calls this and
 * then reports success with no exception - so a reverted "Resume" could
 * show "Bot resumed." on screen while the vault was still paused on chain,
 * with no visible error at all. Checking status here means a revert now
 * throws and the caller's existing catch/setError path actually fires.
 */
export async function waitForReceipt(txHash, { timeoutMs = 120_000, intervalMs = 3000 } = {}) {
  const rpc = new JsonRpcProvider(RPC_URL);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc.getTransactionReceipt(txHash);
    if (receipt) {
      if (receipt.status === 0) {
        throw new Error(
          `Transaction was mined but REVERTED (${txHash}) - it did not actually take effect. ` +
          "Common causes: the connected wallet isn't the vault's owner, or an on-chain condition " +
          `wasn't met. Look up ${txHash} on a ${CHAIN.chainName} block explorer for the exact reason.`,
        );
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    "Transaction was sent, but confirmation is taking longer than expected. " +
    `Check a ${CHAIN.chainName} block explorer for ${txHash} before retrying - it may still land.`,
  );
}

/**
 * All wallet + on-chain state for the dashboard, in one hook. Every value here
 * comes from a real read against the deployed contracts - nothing is seeded or
 * simulated.
 *
 * Two ways in: connectInjected() (a browser extension like MetaMask/Rabby, or
 * a wallet app's own built-in browser) and connectWalletConnect() (any
 * WalletConnect-compatible wallet - Internet Money, Trust Wallet, hundreds of
 * others - from an ordinary mobile browser that has no injected provider at
 * all). Whichever one succeeds becomes "the" active provider for every
 * subsequent action (deposit, withdraw, save settings, ...) via getProvider().
 */
export function useVault() {
  const [account, setAccount] = useState(null);
  const [vaultAddress, setVaultAddress] = useState(null);
  // "multiVenue" (trades V2 + V3) or "v2" (V2 only) - which factory the
  // connected vault was actually found through, not a guess.
  const [vaultKind, setVaultKind] = useState(null);
  const [vaultInfo, setVaultInfo] = useState(null); // { owner, executor, paused, baseBalance, walletBaseBalance }
  const [connecting, setConnecting] = useState(false);
  // True only during the very first silent-reconnect attempt after a page
  // load - lets index.js hold off showing "Connect Wallet" for the split
  // second it takes to find out a wallet is already authorized, instead of
  // flashing the disconnected screen before flipping back to connected.
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState(null);
  const rawProviderRef = useRef(null); // the active EIP-1193 provider, whichever method connected it
  // Mirrors the account state into a ref purely so refreshVaultInfo can read
  // the current value without account being a useCallback dependency. It
  // used to be one - which meant every setAccount() during connect gave
  // refreshVaultInfo (and, through it, finishConnecting) a new identity
  // mid-call, retriggering the silent-reconnect-on-load effect (it depends
  // on finishConnecting) while the original connect attempt was still
  // in-flight - two concurrent connect attempts racing, one of which loses
  // and never reaches its own setInitializing(false), leaving the "reconnecting
  // your wallet" screen stuck forever. A ref never changes identity, so
  // refreshVaultInfo (and everything downstream of it) stays stable across
  // the very setAccount call it's used to read the result of.
  const accountRef = useRef(null);
  useEffect(() => { accountRef.current = account; }, [account]);

  const getProvider = useCallback(() => {
    if (!rawProviderRef.current) {
      throw new Error("Not connected. Click Connect Wallet or Connect via WalletConnect first.");
    }
    return new BrowserProvider(rawProviderRef.current);
  }, []);

  // walletAddr is explicit when the caller already has it fresher than the
  // account state could be (the connect flow, right after setAccount, before
  // that update has landed) - every other call site omits it and falls back
  // to accountRef, which is current by then.
  const refreshVaultInfo = useCallback(async (addr, walletAddr) => {
    const provider = getProvider();
    const vault = new Contract(addr, VAULT_ABI, provider);
    const wrapped = new Contract(WRAPPED, ERC20_ABI, provider);
    const wallet = walletAddr ?? accountRef.current;
    const [owner, executor, paused, baseBalance, walletBaseBalance] = await Promise.all([
      vault.owner(), vault.executor(), vault.paused(), wrapped.balanceOf(addr),
      wallet ? wrapped.balanceOf(wallet) : Promise.resolve(0n),
    ]);
    setVaultInfo({
      owner, executor, paused,
      baseBalance: formatEther(baseBalance),
      // What's actually sitting in the connected wallet, not the vault -
      // shown next to Deposit so someone isn't guessing how much they can
      // send in, the way vaultInfo.baseBalance already does for Withdraw.
      walletBaseBalance: formatEther(walletBaseBalance),
    });
  }, [getProvider]);

  /** Shared finish-up once ANY connection method has produced accounts on a raw provider. */
  const finishConnecting = useCallback(async (rawProvider, accounts) => {
    if (!accounts?.[0]) throw new Error("No account returned by wallet.");
    rawProviderRef.current = rawProvider;
    const provider = new BrowserProvider(rawProvider);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) {
      throw new Error(`Wrong network. Please switch your wallet to ${CHAIN.chainName} (chain ID ${CHAIN_ID}).`);
    }
    setAccount(accounts[0]);

    // Most capable factory checked first - if someone somehow has a vault
    // from more than one, the dashboard shows the most capable one.
    let addr = ZeroAddress;
    let kind = null;
    if (MULTI_VENUE_V4_VAULT_FACTORY) {
      const v4Factory = new Contract(MULTI_VENUE_V4_VAULT_FACTORY, VAULT_FACTORY_ABI, provider);
      addr = await v4Factory.vaultOf(accounts[0]);
      if (addr !== ZeroAddress) kind = "multiVenueV4";
    }
    if (addr === ZeroAddress && MULTI_VENUE_VAULT_FACTORY) {
      const mvFactory = new Contract(MULTI_VENUE_VAULT_FACTORY, VAULT_FACTORY_ABI, provider);
      addr = await mvFactory.vaultOf(accounts[0]);
      if (addr !== ZeroAddress) kind = "multiVenue";
    }
    if (addr === ZeroAddress) {
      const factory = new Contract(VAULT_FACTORY, VAULT_FACTORY_ABI, provider);
      addr = await factory.vaultOf(accounts[0]);
      if (addr !== ZeroAddress) kind = "v2";
    }

    if (addr === ZeroAddress) {
      setVaultAddress(null);
      setVaultKind(null);
      setVaultInfo(null);
    } else {
      setVaultAddress(addr);
      setVaultKind(kind);
      await refreshVaultInfo(addr, accounts[0]);
    }
  }, [refreshVaultInfo]);

  /**
   * Reconnects on page load without ever prompting the wallet, so a plain
   * browser refresh doesn't log the user out and force them through
   * Connect Wallet again. Two paths, tried in the same order manual connect
   * prefers:
   *  - Injected (MetaMask/Rabby/etc): eth_accounts (not eth_requestAccounts)
   *    returns accounts the wallet already authorized for this site with no
   *    popup at all - that's the whole trick.
   *  - WalletConnect: EthereumProvider restores its own session from
   *    localStorage during init() when one exists, so if init() comes back
   *    already .connected there's nothing left to prompt for either.
   * Any failure here (wrong network, no prior authorization, no persisted
   * WalletConnect session) is swallowed on purpose - it just means falling
   * back to the ordinary "Connect Wallet" screen, not an error worth
   * alarming the user with on every page load.
   */
  useEffect(() => {
    let cancelled = false;
    async function tryReconnect() {
      try {
        if (typeof window !== "undefined" && window.ethereum) {
          const accounts = await window.ethereum.request({ method: "eth_accounts" });
          if (!cancelled && accounts?.length) {
            await finishConnecting(window.ethereum, accounts);
            return;
          }
        }
      } catch { /* fall through to WalletConnect */ }
      try {
        if (!cancelled && walletConnectConfigured()) {
          const wcProvider = await getWalletConnectProvider();
          if (!cancelled && wcProvider.connected && wcProvider.accounts?.length) {
            await finishConnecting(wcProvider, wcProvider.accounts);
          }
        }
      } catch { /* no persisted session - fine, user connects manually */ }
    }
    tryReconnect().finally(() => { if (!cancelled) setInitializing(false); });
    return () => { cancelled = true; };
  }, [finishConnecting]);

  /** Browser extension (MetaMask, Rabby, ...) or a wallet app's own built-in browser. */
  const connectInjected = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      if (typeof window === "undefined" || !window.ethereum) {
        throw new Error("No browser wallet found. Install MetaMask (or a similar extension), " +
          "or use Connect via WalletConnect instead if you're on a phone.");
      }
      const provider = new BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      await finishConnecting(window.ethereum, accounts);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setConnecting(false);
    }
  }, [finishConnecting]);

  /** Any WalletConnect-compatible wallet app, from any ordinary browser. Shows a
   * QR code (desktop) or deep-links directly into the wallet app (mobile). */
  const connectWalletConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const wcProvider = await getWalletConnectProvider();
      const accounts = await wcProvider.enable();
      await finishConnecting(wcProvider, accounts);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setConnecting(false);
    }
  }, [finishConnecting]);

  const disconnect = useCallback(async () => {
    const raw = rawProviderRef.current;
    if (raw && typeof raw.disconnect === "function") {
      try { await raw.disconnect(); } catch { /* best effort */ }
    }
    rawProviderRef.current = null;
    setAccount(null);
    setVaultAddress(null);
    setVaultKind(null);
    setVaultInfo(null);
  }, []);

  /** New vaults always come from the most capable factory deployed - V4
   * (V2+V3+V4) where configured, else V3 (V2+V3), else the V2-only factory.
   * Either way this only ever runs for someone who doesn't have a vault yet -
   * see the on-chain "vault exists" check in every factory contract. */
  const createVault = useCallback(async (onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const factoryAddr = MULTI_VENUE_V4_VAULT_FACTORY || MULTI_VENUE_VAULT_FACTORY || VAULT_FACTORY;
      const newKind = MULTI_VENUE_V4_VAULT_FACTORY ? "multiVenueV4"
        : MULTI_VENUE_VAULT_FACTORY ? "multiVenue" : "v2";
      const factory = new Contract(factoryAddr, VAULT_FACTORY_ABI, signer);
      onProgress?.("Confirm the transaction in your wallet...");
      const tx = await factory.createVault([]);
      onProgress?.("Waiting for it to confirm on-chain...");
      await waitForReceipt(tx.hash);
      const addr = await factory.vaultOf(account);
      setVaultAddress(addr);
      setVaultKind(newKind);
      await refreshVaultInfo(addr);
      return addr;
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [account, getProvider, refreshVaultInfo]);

  /**
   * Deposit the wrapped base token (WPLS / WETH) into the connected vault.
   * Two transactions: approve the vault to pull the tokens, then the deposit.
   */
  const depositBase = useCallback(async (amount_, onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const amount = parseEther(String(amount_));
      const wrapped = new Contract(WRAPPED, ERC20_ABI, signer);
      onProgress?.("Step 1 of 2: confirm the approval in your wallet...");
      const approveTx = await wrapped.approve(vaultAddress, amount);
      onProgress?.("Waiting for the approval to confirm on-chain...");
      await waitForReceipt(approveTx.hash);
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      onProgress?.("Step 2 of 2: confirm the deposit in your wallet...");
      const depositTx = await vault.deposit(WRAPPED, amount);
      onProgress?.("Waiting for the deposit to confirm on-chain...");
      await waitForReceipt(depositTx.hash);
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  /**
   * Symbol, decimals, and the CONNECTED WALLET's balance of an arbitrary
   * token - not the vault's balance (that's vaultInfo/getPortfolioToken's
   * job). Feeds the "Deposit a Token" panel: paste an address, see what you
   * actually hold before typing an amount, same reasoning as
   * vaultInfo.walletBaseBalance existing so WPLS deposits aren't a guess.
   * Returns null on any failure (not a real token, wrong network, etc.) -
   * the caller shows "can't find that token" rather than a stack trace.
   */
  const getTokenWalletInfo = useCallback(async (tokenAddress) => {
    try {
      const provider = getProvider();
      const erc = new Contract(tokenAddress, ERC20_ABI, provider);
      const [symbol, decimals, balanceRaw] = await Promise.all([
        erc.symbol(), erc.decimals(), erc.balanceOf(account),
      ]);
      return { symbol, decimals, balance: formatUnits(balanceRaw, decimals) };
    } catch {
      return null;
    }
  }, [account, getProvider]);

  /**
   * Deposits a token OTHER than the base currency directly into the vault -
   * a plain wallet-to-vault transfer, not the vault's own deposit()
   * function (that one only accepts its allow-listed tokens, which on
   * PulseChain is WPLS alone - see BotVault.sol's deposit()). A plain
   * ERC20 transfer works for any token regardless of that allow-list, since
   * the vault doesn't need to cooperate to receive it. After it confirms,
   * signs and sends a deposit notice so the keeper starts tracking it as a
   * position (see lib/depositTokenNotice.js and keeper/src/deposits.ts) -
   * best-effort: if the notice fails to send, the deposit itself already
   * succeeded, and the keeper will still pick up the balance whenever the
   * next notice or a manual retry gets through.
   */
  const depositToken = useCallback(async (tokenAddress, amount_, onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const erc = new Contract(tokenAddress, ERC20_ABI, signer);
      const decimals = await erc.decimals();
      const amount = parseUnits(String(amount_), decimals);
      onProgress?.("Confirm the transfer in your wallet...");
      const tx = await erc.transfer(vaultAddress, amount);
      onProgress?.("Waiting for it to confirm on-chain...");
      await waitForReceipt(tx.hash);
      onProgress?.("Telling the bot to start tracking it...");
      try {
        await notifyDeposit(getProvider, vaultAddress, tokenAddress);
      } catch (e) {
        // The transfer already succeeded - this is just the "please look"
        // notice failing to send, not the deposit itself. Surfaced as a
        // status message, not thrown, so the caller doesn't report the
        // whole deposit as failed when the tokens are already in the vault.
        onProgress?.(`Deposit sent, but couldn't notify the bot yet: ${e.message}`);
      }
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  /**
   * Withdraw the wrapped base token from the connected vault back to the
   * owner's wallet. Owner-only on chain - the escape hatch, available
   * directly from the UI.
   */
  const withdrawBase = useCallback(async (amount_, onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const amount = parseEther(String(amount_));
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      onProgress?.("Confirm the withdrawal in your wallet...");
      const tx = await vault.withdraw(WRAPPED, amount);
      onProgress?.("Waiting for it to confirm on-chain...");
      await waitForReceipt(tx.hash);
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  /**
   * Withdraws the vault's entire balance of one arbitrary token straight to
   * the owner's wallet - the manual escape hatch for a position the keeper
   * isn't exiting on its own for whatever reason (see the vault contract's
   * withdrawAll: owner-only, reads the vault's real live balance itself so
   * there's no amount to get wrong). This is a real trade-execution
   * workaround, not a UI nicety - it exists because the automated exit path
   * can fail silently and the owner needs a way to get their funds out that
   * doesn't depend on the keeper at all.
   */
  const withdrawToken = useCallback(async (tokenAddress, onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      onProgress?.("Confirm the withdrawal in your wallet...");
      const tx = await vault.withdrawAll([tokenAddress]);
      onProgress?.("Waiting for it to confirm on-chain...");
      await waitForReceipt(tx.hash);
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  /**
   * Pauses or resumes the vault. While paused, executeSwap reverts for the
   * keeper (checked on chain, live() modifier) - the fastest way to stop the
   * bot without touching the keeper server or its executor key. Owner-only,
   * and withdraw stays available even while paused (the escape hatch is
   * never gated by this).
   */
  const setPaused = useCallback(async (paused, onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      onProgress?.("Confirm the transaction in your wallet...");
      const tx = await vault.setPaused(paused);
      onProgress?.("Waiting for it to confirm on-chain...");
      await waitForReceipt(tx.hash);
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  /**
   * Permanently strips the keeper's ability to trade this vault - the
   * escape hatch CLAUDE.md's invariants require to work regardless of
   * whether the keeper server is even running, since the on-chain check is
   * everything (see BotVault.sol's executor-gated executeSwap). Unlike
   * setPaused (a toggle), this is one-way from the site's UI: getting the
   * keeper trading again after this requires a fresh setExecutor() call,
   * deliberately not exposed here - revoking should be the easy, fast path
   * (one click, no second-guessing), re-granting should not be.
   */
  const revokeExecutor = useCallback(async (onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      onProgress?.("Confirm the transaction in your wallet...");
      const tx = await vault.revokeExecutor();
      onProgress?.("Waiting for it to confirm on-chain...");
      await waitForReceipt(tx.hash);
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  return {
    account, vaultAddress, vaultKind, vaultInfo, connecting, initializing, error,
    connectInjected, connectWalletConnect, disconnect,
    createVault, depositBase, depositToken, getTokenWalletInfo, withdrawBase, withdrawToken, setPaused, revokeExecutor, refreshVaultInfo, getProvider,
  };
}
