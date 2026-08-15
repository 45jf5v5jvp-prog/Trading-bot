import { useCallback, useRef, useState } from "react";
import { BrowserProvider, Contract, formatEther, parseEther, ZeroAddress } from "ethers";
import { CHAIN_ID, VAULT_FACTORY, VAULT_FACTORY_ABI, VAULT_ABI, WPLS, ERC20_ABI } from "./contracts";
import { getWalletConnectProvider } from "./walletConnect";

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
  const [vaultInfo, setVaultInfo] = useState(null); // { owner, executor, paused, wplsBalance }
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const rawProviderRef = useRef(null); // the active EIP-1193 provider, whichever method connected it

  const getProvider = useCallback(() => {
    if (!rawProviderRef.current) {
      throw new Error("Not connected. Click Connect Wallet or Connect via WalletConnect first.");
    }
    return new BrowserProvider(rawProviderRef.current);
  }, []);

  const refreshVaultInfo = useCallback(async (addr) => {
    const provider = getProvider();
    const vault = new Contract(addr, VAULT_ABI, provider);
    const wpls = new Contract(WPLS, ERC20_ABI, provider);
    const [owner, executor, paused, wplsBalance] = await Promise.all([
      vault.owner(), vault.executor(), vault.paused(), wpls.balanceOf(addr),
    ]);
    setVaultInfo({ owner, executor, paused, wplsBalance: formatEther(wplsBalance) });
  }, [getProvider]);

  /** Shared finish-up once ANY connection method has produced accounts on a raw provider. */
  const finishConnecting = useCallback(async (rawProvider, accounts) => {
    if (!accounts?.[0]) throw new Error("No account returned by wallet.");
    rawProviderRef.current = rawProvider;
    const provider = new BrowserProvider(rawProvider);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) {
      throw new Error(`Wrong network. Please switch your wallet to PulseChain (chain ID ${CHAIN_ID}).`);
    }
    setAccount(accounts[0]);

    const factory = new Contract(VAULT_FACTORY, VAULT_FACTORY_ABI, provider);
    const addr = await factory.vaultOf(accounts[0]);
    if (addr === ZeroAddress) {
      setVaultAddress(null);
      setVaultInfo(null);
    } else {
      setVaultAddress(addr);
      await refreshVaultInfo(addr);
    }
  }, [refreshVaultInfo]);

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
    setVaultInfo(null);
  }, []);

  const createVault = useCallback(async () => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const factory = new Contract(VAULT_FACTORY, VAULT_FACTORY_ABI, signer);
      const tx = await factory.createVault([]);
      await tx.wait();
      const addr = await factory.vaultOf(account);
      setVaultAddress(addr);
      await refreshVaultInfo(addr);
      return addr;
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [account, getProvider, refreshVaultInfo]);

  /**
   * Deposit WPLS into the connected vault. Two transactions: approve the
   * vault to pull the tokens, then the deposit itself - the same two-step
   * flow proven manually in Remix earlier tonight, now driven from the UI.
   */
  const depositWpls = useCallback(async (amountPls) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const amount = parseEther(String(amountPls));
      const wpls = new Contract(WPLS, ERC20_ABI, signer);
      const approveTx = await wpls.approve(vaultAddress, amount);
      await approveTx.wait();
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      const depositTx = await vault.deposit(WPLS, amount);
      await depositTx.wait();
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  /**
   * Withdraw WPLS from the connected vault back to the owner's wallet.
   * Owner-only on chain - this is the escape hatch, proven manually earlier
   * tonight, now available directly from the UI.
   */
  const withdrawWpls = useCallback(async (amountPls) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const amount = parseEther(String(amountPls));
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      const tx = await vault.withdraw(WPLS, amount);
      await tx.wait();
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
  const setPaused = useCallback(async (paused) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      const tx = await vault.setPaused(paused);
      await tx.wait();
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  return {
    account, vaultAddress, vaultInfo, connecting, error,
    connectInjected, connectWalletConnect, disconnect,
    createVault, depositWpls, withdrawWpls, setPaused, refreshVaultInfo, getProvider,
  };
}
