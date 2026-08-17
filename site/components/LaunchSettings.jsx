import { numberFieldProps } from "../lib/numberField";

/** Editor for the launch bot (new-pair sniper) settings. Same shape the
 * keeper's screener/launch.ts already enforces - this just exposes it. */
export default function LaunchSettings({ launch, onChange }) {
  const num = (field) => numberFieldProps(launch[field] ?? 0, (v) => onChange({ ...launch, [field]: v }));

  return (
    <div>
      <div className="section-label">Launch Bot</div>
      <p className="hint" style={{ marginBottom: 14 }}>Buys brand-new pairs on Robinhood Chain the moment they open.</p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={launch.enabled} onChange={(e) => onChange({ ...launch, enabled: e.target.checked })} />
        {launch.enabled ? "Launch Bot is ON — it will buy new pairs automatically" : "Launch Bot is OFF — settings are saved but it will not trade"}
      </label>

      <div className="field-inline">
        <label>ETH per launch</label>
        <input {...num("perLaunchPls")} min="0" style={{ width: 100 }} />
        <label>Max buys/day</label>
        <input {...num("maxPerDay")} min="0" style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Take profit %</label>
        <input {...num("takeProfitPct")} min="0" style={{ width: 80 }} />
        <label>Stop loss %</label>
        <input {...num("stopLossPct")} min="0" style={{ width: 80 }} />
        <label>Time exit (min)</label>
        <input {...num("timeExitMin")} min="0" style={{ width: 80 }} />
      </div>

      <div className="sub-label">Screening limits (a token failing any of these is skipped, never bought)</div>

      <div className="field-inline">
        <label>Max buy tax (bps)</label>
        <input {...num("maxBuyTaxBps")} min="0" style={{ width: 90 }} />
        <label>Max sell tax (bps)</label>
        <input {...num("maxSellTaxBps")} min="0" style={{ width: 90 }} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={launch.requireLpLock} onChange={(e) => onChange({ ...launch, requireLpLock: e.target.checked })} />
        Require LP locked/burned
      </label>

      <div className="field-inline">
        <label>Max deployer holding %</label>
        <input {...num("maxDeployerPct")} min="0" style={{ width: 80 }} />
        <label>Min liquidity (ETH)</label>
        <input {...num("minLiquidityPls")} min="0" style={{ width: 110 }} />
      </div>
    </div>
  );
}
