import { useEffect, useState } from "react";
import { useVault } from "../lib/useVault";
import { loadConfig, saveConfig } from "../lib/saveConfig";
import { loadHistory } from "../lib/loadHistory";
import { loadPortfolio } from "../lib/loadPortfolio";
import { loadOpportunities } from "../lib/loadOpportunities";
import { closePosition } from "../lib/closePosition";
import { buyOpportunity } from "../lib/buyOpportunity";
import { numberFieldProps } from "../lib/numberField";
import { CHAIN } from "../lib/contracts";
import RulesList from "../components/RulesList";
import SnipesList from "../components/SnipesList";
import PortfolioPanel from "../components/PortfolioPanel";
import LimitOrdersList from "../components/LimitOrdersList";
import LaunchSettings from "../components/LaunchSettings";
import DiscoverySettings from "../components/DiscoverySettings";
import HunterSettings from "../components/HunterSettings";
import OpportunitiesPanel from "../components/OpportunitiesPanel";
import AskIcaria from "../components/AskIcaria";
import HistoryPanel from "../components/HistoryPanel";
import Sun from "../components/Sun";

/** Balance in the chain's wrapped base token. The per-chain decimal budget
 * comes from the chain preset: WPLS balances are millions where fractional
 * dust is noise; ETH-scale balances are tiny and the fraction is the money. */
function fmtBalance(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  // Truncated, never rounded. Rounding up shows a number a hair above the
  // real balance, and typing that number back in makes an exact-balance
  // withdrawal fail - found the hard way. What's displayed must always be
  // withdrawable as typed.
  const scale = 10 ** CHAIN.balanceMaxDecimals;
  const floored = Math.floor(n * scale) / scale;
  return floored.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: CHAIN.balanceMaxDecimals });
}

export default function Dashboard() {
  const {
    account, vaultAddress, vaultKind, vaultInfo, connecting, initializing, error,
    connectInjected, connectWalletConnect, createVault, depositBase, withdrawBase, withdrawToken, setPaused, refreshVaultInfo, getProvider,
  } = useVault();
  const [config, setConfig] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [opportunities, setOpportunities] = useState(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [txBusy, setTxBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [closeStates, setCloseStates] = useState({}); // { [positionId]: "pending" | "requested" | "error" }
  const [buyStates, setBuyStates] = useState({}); // { [opportunityId]: "pending" | "requested" | "error" }
  const [tokenWithdrawAddr, setTokenWithdrawAddr] = useState("");
  const [tokenWithdrawBusy, setTokenWithdrawBusy] = useState(false);

  /** Every edit to config goes through here so "unsaved changes" stays accurate -
   * nothing takes effect for the keeper until Save All Settings actually signs
   * and persists it, and that's easy to forget without a visible reminder. */
  function updateConfig(next) {
    setConfig(next);
    setDirty(true);
  }

  useEffect(() => {
    if (!vaultAddress) return;
    loadConfig(vaultAddress)
      .then((loaded) => { setConfig(loaded); setDirty(false); })
      .catch((e) => setStatus(`Could not load saved settings: ${e.message}`));
  }, [vaultAddress]);

  // Backstop for the case where someone edits settings and closes the tab
  // instead of scrolling down to Save All Settings.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Polled independently of config (which only needs to load once) so open
  // positions' live P/L keeps updating without the user refreshing the page.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const refresh = () => loadHistory(vaultAddress).then((h) => { if (!cancelled) setHistory(h); }).catch(() => {});
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress]);

  // Same polling idea for the Portfolio panel - live balances/values for
  // whatever tokens the saved limit orders reference.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const refresh = () => loadPortfolio(vaultAddress).then((p) => { if (!cancelled) setPortfolio(p.portfolio); }).catch(() => {});
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress]);

  // Same polling idea for the Opportunities panel - Discovery Bot's findings
  // are global (one scanner, shared across every vault), so this is a plain
  // poll rather than tied to any config the owner set.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const refresh = () => loadOpportunities(vaultAddress).then((o) => { if (!cancelled) setOpportunities(o.opportunities); }).catch(() => {});
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress]);

  // Same idea for the vault's balance/paused state - previously this only
  // updated right after a deposit/withdraw/pause, so the balance would sit
  // stale until the user did something. Silent failures here (e.g. the
  // wallet was disconnected in the background) just skip a tick rather than
  // surfacing an error every 20 seconds.
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    const id = setInterval(() => { if (!cancelled) refreshVaultInfo(vaultAddress).catch(() => {}); }, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [vaultAddress, refreshVaultInfo]);

  /** Manual "Refresh" button - updates balance and holdings immediately
   * instead of waiting for the next 20s poll, without reloading the page
   * (which would otherwise mean reconnecting the wallet). */
  async function handleRefresh() {
    setRefreshing(true);
    try {
      const [, h, p, o] = await Promise.all([
        refreshVaultInfo(vaultAddress), loadHistory(vaultAddress), loadPortfolio(vaultAddress), loadOpportunities(vaultAddress),
      ]);
      setHistory(h);
      setPortfolio(p.portfolio);
      setOpportunities(o.opportunities);
    } catch (e) {
      setStatus(`Refresh failed: ${e.message}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setStatus("");
    try {
      const saved = await saveConfig(getProvider, vaultAddress, config);
      setConfig(saved);
      setDirty(false);
      setStatus("Saved. The keeper picks this up on its next refresh cycle.");
    } catch (e) {
      setStatus(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateVault() {
    setTxBusy(true);
    setStatus("");
    try {
      await createVault(setStatus);
      setStatus("Vault created.");
    } catch (e) {
      setStatus(`Create vault failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  async function handleDeposit() {
    if (!amount) return;
    setTxBusy(true);
    setStatus("");
    try {
      await depositBase(amount, setStatus);
      setStatus(`Deposited ${amount} ${CHAIN.baseSymbol}.`);
      setAmount("");
    } catch (e) {
      setStatus(`Deposit failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  async function handleWithdraw() {
    if (!amount) return;
    setTxBusy(true);
    setStatus("");
    try {
      await withdrawBase(amount, setStatus);
      setStatus(`Withdrew ${amount} ${CHAIN.baseSymbol}.`);
      setAmount("");
    } catch (e) {
      setStatus(`Withdraw failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  async function handleTogglePause() {
    setTxBusy(true);
    setStatus("");
    try {
      const next = !vaultInfo.paused;
      await setPaused(next, setStatus);
      setStatus(next ? "Bot paused. The keeper cannot trade this vault until you resume it." : "Bot resumed.");
    } catch (e) {
      setStatus(`Pause/resume failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  /** Pulls the vault's entire balance of one token directly to the owner's
   * wallet. The escape hatch for a position the keeper isn't exiting on its
   * own - doesn't sell anything, just gets it out of the vault so it can be
   * sold manually. Separate from Close Position, which asks the keeper to
   * sell; this bypasses the keeper entirely. */
  async function handleWithdrawToken() {
    if (!tokenWithdrawAddr) return;
    setTokenWithdrawBusy(true);
    setStatus("");
    try {
      await withdrawToken(tokenWithdrawAddr, setStatus);
      setStatus(`Withdrew all of ${tokenWithdrawAddr} to your wallet.`);
      setTokenWithdrawAddr("");
    } catch (e) {
      setStatus(`Token withdraw failed: ${e.message}`);
    } finally {
      setTokenWithdrawBusy(false);
    }
  }

  /** Signs and submits a close request for one open position. Doesn't sell
   * anything itself - the keeper does that on its next pass, see
   * lib/closePosition.js. */
  async function handleClosePosition(positionId) {
    setCloseStates((s) => ({ ...s, [positionId]: "pending" }));
    try {
      await closePosition(getProvider, vaultAddress, positionId);
      setCloseStates((s) => ({ ...s, [positionId]: "requested" }));
    } catch (e) {
      setCloseStates((s) => ({ ...s, [positionId]: "error" }));
      setStatus(`Close request failed: ${e.message}`);
    }
  }

  /** Signs and submits a manual buy request for one Discovery Bot
   * opportunity. Doesn't buy anything itself - the keeper does that on its
   * next pass, see lib/buyOpportunity.js. */
  async function handleBuyOpportunity(opportunityId) {
    setBuyStates((s) => ({ ...s, [opportunityId]: "pending" }));
    try {
      await buyOpportunity(getProvider, vaultAddress, opportunityId);
      setBuyStates((s) => ({ ...s, [opportunityId]: "requested" }));
    } catch (e) {
      setBuyStates((s) => ({ ...s, [opportunityId]: "error" }));
      setStatus(`Buy request failed: ${e.message}`);
    }
  }

  return (
    <div className="page">
      <div className="container">
        <div className="header">
          <Sun size={26} />
          <span className="brand wordmark">ICARIA</span>
          <span className="wordmark-sub">Bots</span>
          <span className="beta-badge">BETA</span>
        </div>

        {initializing && !account && (
          <div className="panel">
            <p className="lede" style={{ marginBottom: 0 }}>Reconnecting your wallet...</p>
          </div>
        )}

        {!initializing && !account && (
          <div className="panel">
            <p className="lede" style={{ marginBottom: 20 }}>
              Connect the wallet that owns your vault to view its balance, adjust trading rules,
              or deposit and withdraw.
            </p>
            <div className="row">
              <button className="btn btn-primary" onClick={connectInjected} disabled={connecting}>
                {connecting ? "Connecting..." : "Connect Wallet"}
              </button>
              <button className="btn" onClick={connectWalletConnect} disabled={connecting}>
                {connecting ? "Connecting..." : "Connect via WalletConnect"}
              </button>
            </div>
            <p className="hint">
              On desktop with a wallet extension installed, use "Connect Wallet." On a phone, or with
              a wallet like Internet Money that isn't a browser extension, use "Connect via WalletConnect."
            </p>
          </div>
        )}

        {account && !vaultAddress && (
          <div className="panel">
            <p className="mono-addr" style={{ marginBottom: 14 }}>Connected: {account}</p>
            <p className="lede" style={{ marginBottom: 16 }}>No vault found for this wallet yet.</p>
            <button className="btn btn-primary" onClick={handleCreateVault} disabled={txBusy}>
              {txBusy ? "Working..." : "Create My Vault"}
            </button>
          </div>
        )}

        {account && vaultAddress && vaultInfo && (
          <div>
            <div className="panel">
              <p className="mono-addr" style={{ marginBottom: 4 }}>Connected: {account}</p>
              <div className="section-label" style={{ marginTop: 18 }}>Your Vault</div>
              <p className="mono-addr" style={{ marginBottom: 4 }}>{vaultAddress}</p>
              <p className="hint" style={{ marginBottom: 14 }}>
                {vaultKind === "multiVenueV4" ? "Trades on V2, V3, and V4" : vaultKind === "multiVenue" ? "Trades on V2 and V3" : "Trades on V2 only"}
              </p>

              <div className="row-between">
                <div>
                  <span className="num" style={{ fontSize: 28 }}>{fmtBalance(vaultInfo.baseBalance)}</span>
                  <span style={{ color: "var(--ash)", marginLeft: 8, fontSize: 13 }}>{CHAIN.baseSymbol}</span>
                </div>
                <div className="row">
                  <span className={vaultInfo.paused ? "badge badge-paused" : "badge badge-active"}>
                    {vaultInfo.paused ? "Paused" : "Active"}
                  </span>
                  <button className="btn btn-small" onClick={handleRefresh} disabled={refreshing}>
                    {refreshing ? "Refreshing..." : "Refresh"}
                  </button>
                  <button className="btn btn-small" onClick={handleTogglePause} disabled={txBusy}>
                    {txBusy ? "Working..." : vaultInfo.paused ? "Resume Bot" : "Pause Bot"}
                  </button>
                </div>
              </div>
              <p className="hint">
                Balance and holdings update automatically every 20 seconds - use Refresh to update
                immediately instead of waiting. Pausing stops the keeper from trading immediately.
                It does not affect deposits or withdrawals, which always stay available to you as
                the owner.
              </p>
            </div>

            <div className="panel">
              <div className="section-label">Deposit / Withdraw</div>
              <div className="field-inline">
                <label>Amount ({CHAIN.baseSymbol})</label>
                <input type="number" onFocus={(e) => e.target.select()} value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 160 }} />
                {/* The exact on-chain balance to full precision - the displayed
                    balance is truncated for reading and typing it back in can
                    never quite empty the vault. */}
                <button type="button" className="btn btn-small" onClick={() => setAmount(vaultInfo.baseBalance)}>
                  Max
                </button>
              </div>
              <div className="row">
                <button className="btn btn-primary" onClick={handleDeposit} disabled={txBusy || !amount}>
                  {txBusy ? "Working..." : "Deposit"}
                </button>
                <button className="btn" onClick={handleWithdraw} disabled={txBusy || !amount}>
                  {txBusy ? "Working..." : "Withdraw"}
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="section-label">Emergency: Withdraw a Token Directly</div>
              <p className="hint" style={{ marginBottom: 14 }}>
                If a position won't close through the normal Close Position button, this pulls the
                vault's entire balance of that token straight to your own wallet - it doesn't sell it,
                just gets it out so you can sell it yourself.
              </p>
              <div className="field-inline">
                <label>Token address</label>
                <input type="text" placeholder="0x..." value={tokenWithdrawAddr}
                  onChange={(e) => setTokenWithdrawAddr(e.target.value)} style={{ width: 340 }} />
              </div>
              <button className="btn btn-danger" onClick={handleWithdrawToken} disabled={tokenWithdrawBusy || !tokenWithdrawAddr}>
                {tokenWithdrawBusy ? "Working..." : "Withdraw This Token"}
              </button>
            </div>

            <div className="panel">
              <HistoryPanel history={history} onClosePosition={handleClosePosition} closeStates={closeStates} />
            </div>

            {config && (
              <>
                {dirty && (
                  <div className="status-msg" style={{ marginBottom: 20, borderColor: "var(--amber)", color: "var(--amber)" }}>
                    You have unsaved changes. Nothing below takes effect for the bot until you click
                    "Save All Settings" at the bottom of this page.
                  </div>
                )}

                <div className="panel">
                  <div className="section-label">Safety</div>
                  <div className="field-inline">
                    <label>Never let one token exceed</label>
                    <input {...numberFieldProps(config.maxHoldingPct, (v) => updateConfig({ ...config, maxHoldingPct: v }))}
                      min="0" max="100" style={{ width: 70 }} />
                    <span style={{ color: "var(--ash)", fontSize: 13 }}>% of the vault</span>
                  </div>
                  <p className="hint">
                    The most important safety setting. Stops one bad bot from putting the whole
                    vault into one falling token.
                  </p>
                </div>

                <div className="panel">
                  <RulesList
                    rules={config.rules}
                    onChange={(rules) => updateConfig({ ...config, rules })}
                  />
                </div>

                <div className="panel">
                  <LaunchSettings
                    launch={config.launch}
                    onChange={(launch) => updateConfig({ ...config, launch })}
                  />
                </div>

                <div className="panel">
                  <SnipesList
                    snipes={config.snipes ?? []}
                    onChange={(snipes) => updateConfig({ ...config, snipes })}
                  />
                </div>

                <div className="panel">
                  <DiscoverySettings
                    discovery={config.discovery}
                    onChange={(discovery) => updateConfig({ ...config, discovery })}
                  />
                </div>

                <div className="panel">
                  <HunterSettings
                    hunter={config.hunter}
                    onChange={(hunter) => updateConfig({ ...config, hunter })}
                  />
                </div>

                <div className="panel">
                  <OpportunitiesPanel
                    opportunities={opportunities}
                    onBuy={handleBuyOpportunity}
                    buyStates={buyStates}
                  />
                </div>

                <div className="panel">
                  <AskIcaria vaultAddress={vaultAddress} getProvider={getProvider} />
                </div>

                <div className="panel">
                  <PortfolioPanel portfolio={portfolio} />
                </div>

                <div className="panel">
                  <LimitOrdersList
                    orders={config.limitOrders ?? []}
                    onChange={(limitOrders) => updateConfig({ ...config, limitOrders })}
                  />
                </div>

                <button className={dirty ? "btn btn-primary" : "btn"} onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : dirty ? "Save All Settings (unsaved changes)" : "Save All Settings"}
                </button>

                {/* Pinned to the viewport while anything is unsaved - the top-of-page
                    warning scrolls away, and an unsaved launch bot someone believes
                    is live is the single most confusing failure this UI can produce. */}
                {dirty && (
                  <div className="unsaved-bar">
                    <span>Your changes are NOT live yet - the bot is still running the old settings.</span>
                    <button className="btn btn-primary btn-small" onClick={handleSave} disabled={saving}>
                      {saving ? "Saving..." : "Save now"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {status && <p className="status-msg" style={{ marginTop: 20 }}>{status}</p>}
        {error && <p className="error-msg" style={{ marginTop: 20 }}>{error}</p>}
      </div>
    </div>
  );
}
