import { CHAIN_ID } from "./contracts";

/**
 * WalletConnect lets a normal mobile browser (Safari, Chrome) connect to any
 * WalletConnect-compatible wallet app (Internet Money, Trust Wallet, Rainbow,
 * hundreds of others) - the injected-provider method in useVault.js only
 * works for browser extensions or a wallet app's own built-in browser, which
 * excludes most phone users visiting the site normally.
 *
 * Requires a free Project ID from https://cloud.reown.com (formerly
 * WalletConnect Cloud) - a one-time signup, not something this code can
 * provide on its own. See SITE-README.md for the exact steps.
 */
const PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

let providerPromise;

export function walletConnectConfigured() {
  return Boolean(PROJECT_ID);
}

/** Lazily creates (once) and returns the WalletConnect EIP-1193 provider. */
export async function getWalletConnectProvider() {
  if (!PROJECT_ID) {
    throw new Error(
      "WalletConnect is not configured yet. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID " +
      "(see SITE-README.md) and rebuild the site.",
    );
  }
  if (!providerPromise) {
    providerPromise = import("@walletconnect/ethereum-provider").then(({ EthereumProvider }) =>
      EthereumProvider.init({
        projectId: PROJECT_ID,
        chains: [CHAIN_ID],
        showQrModal: true,
        metadata: {
          name: "Icaria Bots",
          description: "Automated trading bots on Robinhood Chain",
          url: typeof window !== "undefined" ? window.location.origin : "",
          icons: [],
        },
      }),
    );
  }
  return providerPromise;
}
