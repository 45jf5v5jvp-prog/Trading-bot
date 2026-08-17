import { useCallback, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatEther, parseEther, ZeroAddress } from "ethers";
import { CHAIN_ID, VAULT_FACTORY, VAULT_FACTORY_ABI, VAULT_ABI, WETH, ERC20_ABI, RPC_URL } from "./contracts";
import { getWalletConnectProvider } from "./walletConnect";

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
 */
async function waitForReceipt(txHash, { timeoutMs = 120_000, intervalMs = 3000 } = {}) {
  const rpc = new JsonRpcProvider(RPC_URL);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    "Transaction was sent, but confirmation is taking longer than expected. " +
    `Check a Robinhood Chain block explorer for ${txHash} before retrying - it may still land.`,
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
  const [vaultInfo, setVaultInfo] = useState(null); // { owner, executor, paused, wethBalance }
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
    const weth = new Contract(WETH, ERC20_ABI, provider);
    const [owner, executor, paused, wethBalance] = await Promise.all([
      vault.owner(), vault.executor(), vault.paused(), weth.balanceOf(addr),
    ]);
    setVaultInfo({ owner, executor, paused, wethBalance: formatEther(wethBalance) });
  }, [getProvider]);

  /** Shared finish-up once ANY connection method has produced accounts on a raw provider. */
  const finishConnecting = useCallback(async (rawProvider, accounts) => {
    if (!accounts?.[0]) throw new Error("No account returned by wallet.");
    rawProviderRef.current = rawProvider;
    const provider = new BrowserProvider(rawProvider);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) {
      throw new Error(`Wrong network. Please switch your wallet to Robinhood Chain (chain ID ${CHAIN_ID}).`);
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

  const createVault = useCallback(async (onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const factory = new Contract(VAULT_FACTORY, VAULT_FACTORY_ABI, signer);
      onProgress?.("Confirm the transaction in your wallet...");
      const tx = await factory.createVault([]);
      onProgress?.("Waiting for it to confirm on-chain...");
      await waitForReceipt(tx.hash);
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
   * Deposit WETH into the connected vault. Two transactions: approve the
   * vault to pull the tokens, then the deposit itself.
   */
  const depositWeth = useCallback(async (amountEth, onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const amount = parseEther(String(amountEth));
      const weth = new Contract(WETH, ERC20_ABI, signer);
      onProgress?.("Step 1 of 2: confirm the approval in your wallet...");
      const approveTx = await weth.approve(vaultAddress, amount);
      onProgress?.("Waiting for the approval to confirm on-chain...");
      await waitForReceipt(approveTx.hash);
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      onProgress?.("Step 2 of 2: confirm the deposit in your wallet...");
      const depositTx = await vault.deposit(WETH, amount);
      onProgress?.("Waiting for the deposit to confirm on-chain...");
      await waitForReceipt(depositTx.hash);
      await refreshVaultInfo(vaultAddress);
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    }
  }, [vaultAddress, getProvider, refreshVaultInfo]);

  /**
   * Withdraw WETH from the connected vault back to the owner's wallet.
   * Owner-only on chain - the escape hatch, available directly from the UI.
   */
  const withdrawWeth = useCallback(async (amountEth, onProgress) => {
    setError(null);
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const amount = parseEther(String(amountEth));
      const vault = new Contract(vaultAddress, VAULT_ABI, signer);
      onProgress?.("Confirm the withdrawal in your wallet...");
      const tx = await vault.withdraw(WETH, amount);
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

  return {
    account, vaultAddress, vaultInfo, connecting, error,
    connectInjected, connectWalletConnect, disconnect,
    createVault, depositWeth, withdrawWeth, setPaused, refreshVaultInfo, getProvider,
  };
}
