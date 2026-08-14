import { useEffect, useState } from "react";
import { useVault } from "../lib/useVault";
import { loadConfig, saveConfig } from "../lib/saveConfig";
import { loadHistory } from "../lib/loadHistory";
import RulesList from "../components/RulesList";
import LaunchSettings from "../components/LaunchSettings";
import HistoryPanel from "../components/HistoryPanel";

export default function Dashboard() {
  const {
    account, vaultAddress, vaultInfo, connecting, error,
    connect, createVault, depositWpls, withdrawWpls, setPaused, getProvider,
  } = useVault();
  const [config, setConfig] = useState(null);
  const [history, setHistory] = useState(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [txBusy, setTxBusy] = useState(false);

  useEffect(() => {
    if (!vaultAddress) return;
    loadConfig(vaultAddress)
      .then(setConfig)
      .catch((e) => setStatus(`Could not load saved settings: ${e.message}`));
    loadHistory(vaultAddress)
      .then(setHistory)
      .catch((e) => setStatus(`Could not load bot activity: ${e.message}`));
  }, [vaultAddress]);

  async function handleSave() {
    setSaving(true);
    setStatus("");
    try {
      const saved = await saveConfig(getProvider, vaultAddress, config);
      setConfig(saved);
      setStatus("Saved. The keeper picks this up on its next refresh cycle.");
    } catch (e) {
      setStatus(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeposit() {
    if (!amount) return;
    setTxBusy(true);
    setStatus("");
    try {
      await depositWpls(amount);
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
      await withdrawWpls(amount);
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
      await setPaused(next);
      setStatus(next ? "Bot paused. The keeper cannot trade this vault until you resume it." : "Bot resumed.");
    } catch (e) {
      setStatus(`Pause/resume failed: ${e.message}`);
    } finally {
      setTxBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Icaria Bots</h1>

      {!account && (
        <button onClick={connect} disabled={connecting}>
          {connecting ? "Connecting..." : "Connect Wallet"}
        </button>
      )}

      {account && !vaultAddress && (
        <div>
          <p>Connected: {account}</p>
          <p>No vault found for this wallet yet.</p>
          <button onClick={createVault}>Create My Vault</button>
        </div>
      )}

      {account && vaultAddress && vaultInfo && (
        <div>
          <p>Connected: {account}</p>
          <h2>Your Vault</h2>
          <p>Address: {vaultAddress}</p>
          <p>WPLS balance: {vaultInfo.wplsBalance}</p>
          <p>
            Status: <strong>{vaultInfo.paused ? "PAUSED - the bot cannot trade" : "Active"}</strong>{" "}
            <button onClick={handleTogglePause} disabled={txBusy}>
              {txBusy ? "Working..." : vaultInfo.paused ? "Resume Bot" : "Pause Bot"}
            </button>
          </p>
          <p style={{ fontSize: "0.9em", color: "#555" }}>
            Pausing stops the keeper from trading immediately - it does not affect deposits or
            withdrawals, which always stay available to you as the owner.
          </p>

          <h2>Deposit / Withdraw</h2>
          <label>
            Amount (WPLS):{" "}
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <br />
          <button onClick={handleDeposit} disabled={txBusy || !amount}>
            {txBusy ? "Working..." : "Deposit"}
          </button>{" "}
          <button onClick={handleWithdraw} disabled={txBusy || !amount}>
            {txBusy ? "Working..." : "Withdraw"}
          </button>

          <HistoryPanel history={history} />

          {config && (
            <>
              <h2>Safety</h2>
              <label>
                Never let one token exceed{" "}
                <input type="number" min="0" max="100" value={config.maxHoldingPct}
                  onChange={(e) => setConfig({ ...config, maxHoldingPct: Number(e.target.value) })} />
                {"% "}of the vault (the most important safety setting - stops one bad rule from
                putting the whole vault into one falling token)
              </label>

              <RulesList
                rules={config.rules}
                onChange={(rules) => setConfig({ ...config, rules })}
              />

              <LaunchSettings
                launch={config.launch}
                onChange={(launch) => setConfig({ ...config, launch })}
              />

              <button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save All Settings"}</button>
            </>
          )}
        </div>
      )}

      {status && <p>{status}</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
    </main>
  );
}
