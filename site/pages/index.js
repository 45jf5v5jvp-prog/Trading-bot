import { useEffect, useState } from "react";
import { useVault } from "../lib/useVault";
import { loadConfig, saveConfig } from "../lib/saveConfig";
import { loadHistory } from "../lib/loadHistory";
import { numberFieldProps } from "../lib/numberField";
import RulesList from "../components/RulesList";
import LaunchSettings from "../components/LaunchSettings";
import HistoryPanel from "../components/HistoryPanel";
import Sun from "../components/Sun";

export default function Dashboard() {
  const {
    account, vaultAddress, vaultInfo, connecting, error,
    connectInjected, connectWalletConnect, createVault, depositWpls, withdrawWpls, setPaused, getProvider,
  } = useVault();
  const [config, setConfig] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [txBusy, setTxBusy] = useState(false);

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
      await depositWpls(amount, setStatus);
      setStatus(`Deposited ${amount} WPLS.`);
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
      await withdrawWpls(amount, setStatus);
      setStatus(`Withdrew ${amount} WPLS.`);
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

  return (
    <div className="page">
      <div className="container">
        <div className="header">
          <Sun size={26} />
          <span className="brand wordmark">ICARIA</span>
          <span className="wordmark-sub">Bots</span>
        </div>

        {!account && (
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
              <p className="mono-addr" style={{ marginBottom: 14 }}>{vaultAddress}</p>

              <div className="row-between">
                <div>
                  <span className="num" style={{ fontSize: 28 }}>{vaultInfo.wplsBalance}</span>
                  <span style={{ color: "var(--ash)", marginLeft: 8, fontSize: 13 }}>WPLS</span>
                </div>
                <div className="row">
                  <span className={vaultInfo.paused ? "badge badge-paused" : "badge badge-active"}>
                    {vaultInfo.paused ? "Paused" : "Active"}
                  </span>
                  <button className="btn btn-small" onClick={handleTogglePause} disabled={txBusy}>
                    {txBusy ? "Working..." : vaultInfo.paused ? "Resume Bot" : "Pause Bot"}
                  </button>
                </div>
              </div>
              <p className="hint">
                Pausing stops the keeper from trading immediately. It does not affect deposits or
                withdrawals, which always stay available to you as the owner.
              </p>
            </div>

            <div className="panel">
              <div className="section-label">Deposit / Withdraw</div>
              <div className="field-inline">
                <label>Amount (WPLS)</label>
                <input type="number" onFocus={(e) => e.target.select()} value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 160 }} />
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
              <HistoryPanel history={history} />
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

                <button className={dirty ? "btn btn-primary" : "btn"} onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : dirty ? "Save All Settings (unsaved changes)" : "Save All Settings"}
                </button>
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
