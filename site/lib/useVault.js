import { useCallback, useState } from "react";
import { BrowserProvider, Contract, formatEther, parseEther, ZeroAddress } from "ethers";
import { CHAIN_ID, VAULT_FACTORY, VAULT_FACTORY_ABI, VAULT_ABI, WPLS, ERC20_ABI } from "./contracts";

/**
 * All wallet + on-chain state for the dashboard, in one hook. Every value here
 * comes from a real read against the deployed contracts - nothing is seeded or
 * simulated. connect() does the full flow: connect wallet, look up (or offer
 * to create) the caller's vault, read its live state.
 */
export function useVault() {
  const [account, setAccount] = useState(null);
  const [vaultAddress, setVaultAddress] = useState(null);
  const [vaultInfo, setVaultInfo] = useState(null); // { owner, executor, paused, wplsBalance }
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const getProvider = useCallback(() => {
    if (typeof window === "undefined" || !window.ethereum) {
      throw new Error("No wallet found. Install MetaMask (or a similar wallet) and reload the page.");
    }
    return new BrowserProvider(window.ethereum);
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

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const provider = getProvider();
      const accounts = await provider.send("eth_requestAccounts", []);
      if (!accounts?.[0]) throw new Error("No account returned by wallet.");
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
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setConnecting(false);
    }
  }, [getProvider, refreshVaultInfo]);

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

  return {
    account, vaultAddress, vaultInfo, connecting, error,
    connect, createVault, depositWpls, withdrawWpls, refreshVaultInfo, getProvider,
  };
}
