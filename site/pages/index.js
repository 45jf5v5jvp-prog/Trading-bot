import { useEffect, useState } from "react";
import { useVault } from "../lib/useVault";
import { loadConfig, saveConfig } from "../lib/saveConfig";

const EMPTY_RULE = {
  enabled: true, token: "", direction: "drops", thresholdPct: 10, lookbackHours: 24,
  allocPct: 20, cooldownHours: 6, maxFires: 3, takeProfitPct: 15, stopLossPct: 20,
  trailingStopPct: 8, timeExitMin: 0,
};

export default function Dashboard() {
  const {
    account, vaultAddress, vaultInfo, connecting, error,
    connect, createVault, depositWpls, withdrawWpls, getProvider,
  } = useVault();
  const [config, setConfig] = useState(null);
  const [rule, setRule] = useState(EMPTY_RULE);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [txBusy, setTxBusy] = useState(false);

  useEffect(() => {
    if (!vaultAddress) return;
    loadConfig(vaultAddress).then((c) => {
      setConfig(c);
      if (c.rules?.[0]) setRule({ ...EMPTY_RULE, ...c.rules[0] });
    }).catch((e) => setStatus(`Could not load saved settings: ${e.message}`));
  }, [vaultAddress]);

  async function handleSave() {
    setSaving(true);
    setStatus("");
    try {
      const next = { ...config, rules: [rule] };
      const saved = await saveConfig(getProvider, vaultAddress, next);
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

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
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
          <p>Paused: {String(vaultInfo.paused)}</p>

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

          {config && (
            <>
              <h2>Trading Rule</h2>
              <label>
                Token address:{" "}
                <input value={rule.token} onChange={(e) => setRule({ ...rule, token: e.target.value })} size={44} />
              </label>
              <br />
              <label>
                Direction:{" "}
                <select value={rule.direction} onChange={(e) => setRule({ ...rule, direction: e.target.value })}>
                  <option value="drops">drops</option>
                  <option value="rises">rises</option>
                </select>
              </label>
              <br />
              <label>
                Threshold %:{" "}
                <input type="number" value={rule.thresholdPct}
                  onChange={(e) => setRule({ ...rule, thresholdPct: Number(e.target.value) })} />
              </label>
              <br />
              <label>
                Allocate % of vault per trade:{" "}
                <input type="number" value={rule.allocPct}
                  onChange={(e) => setRule({ ...rule, allocPct: Number(e.target.value) })} />
              </label>
              <br />
              <label>
                Take profit %:{" "}
                <input type="number" value={rule.takeProfitPct}
                  onChange={(e) => setRule({ ...rule, takeProfitPct: Number(e.target.value) })} />
              </label>
              <br />
              <label>
                Stop loss %:{" "}
                <input type="number" value={rule.stopLossPct}
                  onChange={(e) => setRule({ ...rule, stopLossPct: Number(e.target.value) })} />
              </label>
              <br />
              <button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Settings"}</button>
            </>
          )}
        </div>
      )}

      {status && <p>{status}</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
    </main>
  );
}
