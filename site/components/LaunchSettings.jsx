/** Editor for the launch bot (new-pair sniper) settings. Same shape the
 * keeper's screener/launch.ts already enforces - this just exposes it. */
export default function LaunchSettings({ launch, onChange }) {
  const numericFields = ["perLaunchPls", "maxPerDay", "takeProfitPct", "stopLossPct", "timeExitMin",
    "maxBuyTaxBps", "maxSellTaxBps", "maxDeployerPct", "minLiquidityPls"];
  const set = (field) => (e) => {
    const raw = field === "requireLpLock" ? e.target.checked : e.target.value;
    onChange({ ...launch, [field]: numericFields.includes(field) ? Number(raw) : raw });
  };

  return (
    <div>
      <div className="section-label">Launch Bot</div>
      <p className="hint" style={{ marginBottom: 14 }}>Buys brand-new PulseX pairs the moment they open.</p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={launch.enabled} onChange={(e) => onChange({ ...launch, enabled: e.target.checked })} />
        {launch.enabled ? "Launch Bot is ON — it will buy new pairs automatically" : "Launch Bot is OFF — settings are saved but it will not trade"}
      </label>

      <div className="field-inline">
        <label>PLS per launch</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.perLaunchPls} onChange={set("perLaunchPls")} style={{ width: 100 }} />
        <label>Max buys/day</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.maxPerDay} onChange={set("maxPerDay")} style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Take profit %</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.takeProfitPct} onChange={set("takeProfitPct")} style={{ width: 80 }} />
        <label>Stop loss %</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.stopLossPct} onChange={set("stopLossPct")} style={{ width: 80 }} />
        <label>Time exit (min)</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.timeExitMin} onChange={set("timeExitMin")} style={{ width: 80 }} />
      </div>

      <div className="sub-label">Screening limits (a token failing any of these is skipped, never bought)</div>

      <div className="field-inline">
        <label>Max buy tax (bps)</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.maxBuyTaxBps} onChange={set("maxBuyTaxBps")} style={{ width: 90 }} />
        <label>Max sell tax (bps)</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.maxSellTaxBps} onChange={set("maxSellTaxBps")} style={{ width: 90 }} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={launch.requireLpLock} onChange={set("requireLpLock")} />
        Require LP locked/burned
      </label>

      <div className="field-inline">
        <label>Max deployer holding %</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.maxDeployerPct} onChange={set("maxDeployerPct")} style={{ width: 80 }} />
        <label>Min liquidity (PLS)</label>
        <input type="number" onFocus={(e) => e.target.select()} min="0" value={launch.minLiquidityPls} onChange={set("minLiquidityPls")} style={{ width: 110 }} />
      </div>
    </div>
  );
}
