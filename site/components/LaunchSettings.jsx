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
    <fieldset style={{ marginBottom: 12, padding: 12 }}>
      <h2>Launch Bot (buys brand-new PulseX pairs)</h2>
      <label>
        <input type="checkbox" checked={launch.enabled} onChange={(e) => onChange({ ...launch, enabled: e.target.checked })} />
        {" "}Enabled
      </label>
      <div>
        <label>PLS per launch: <input type="number" min="0" value={launch.perLaunchPls} onChange={set("perLaunchPls")} /></label>
        {" "}
        <label>Max buys/day: <input type="number" min="0" value={launch.maxPerDay} onChange={set("maxPerDay")} /></label>
      </div>
      <div>
        <label>Take profit %: <input type="number" min="0" value={launch.takeProfitPct} onChange={set("takeProfitPct")} /></label>
        {" "}
        <label>Stop loss %: <input type="number" min="0" value={launch.stopLossPct} onChange={set("stopLossPct")} /></label>
        {" "}
        <label>Time exit (min): <input type="number" min="0" value={launch.timeExitMin} onChange={set("timeExitMin")} /></label>
      </div>
      <div>
        <em>Screening limits (a token failing any of these is skipped, never bought):</em>
      </div>
      <div>
        <label>Max buy tax (bps): <input type="number" min="0" value={launch.maxBuyTaxBps} onChange={set("maxBuyTaxBps")} /></label>
        {" "}
        <label>Max sell tax (bps): <input type="number" min="0" value={launch.maxSellTaxBps} onChange={set("maxSellTaxBps")} /></label>
      </div>
      <div>
        <label>
          <input type="checkbox" checked={launch.requireLpLock} onChange={set("requireLpLock")} />
          {" "}Require LP locked/burned
        </label>
      </div>
      <div>
        <label>Max deployer holding %: <input type="number" min="0" value={launch.maxDeployerPct} onChange={set("maxDeployerPct")} /></label>
        {" "}
        <label>Min liquidity (PLS): <input type="number" min="0" value={launch.minLiquidityPls} onChange={set("minLiquidityPls")} /></label>
      </div>
    </fieldset>
  );
}
