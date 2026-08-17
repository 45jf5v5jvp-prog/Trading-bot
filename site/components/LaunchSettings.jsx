import { numberFieldProps } from "../lib/numberField";

/** Plain-language description of what a given "max deployer holding %"
 * setting actually does, since the raw number alone ("75%") doesn't convey
 * the tradeoff - it reads like "how much do I let them keep" when it's
 * really "how much protection am I trading away for more launches passing." */
function deployerHoldingLabel(pct) {
  if (pct <= 15) return "Very strict — rejects almost every launch where the creator kept any meaningful share. Strongest rug protection, fewest trades.";
  if (pct <= 40) return "Strict — only lets through launches where the creator gave up most of the supply.";
  if (pct <= 60) return "Balanced — blocks the most obvious cases, lets more launches through.";
  if (pct <= 85) return "Loose — only blocks a creator who kept the overwhelming majority of the supply.";
  return "No protection on this check — every launch passes, no matter how much the creator kept.";
}

/** Editor for the launch bot (new-pair sniper) settings. Same shape the
 * keeper's screener/launch.ts already enforces - this just exposes it. */
export default function LaunchSettings({ launch, onChange }) {
  const num = (field) => numberFieldProps(launch[field] ?? 0, (v) => onChange({ ...launch, [field]: v }));
  const deployerPct = Number(launch.maxDeployerPct) || 0;

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
        <label>Min liquidity (PLS)</label>
        <input {...num("minLiquidityPls")} min="0" style={{ width: 110 }} />
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label>How much of the supply can the token's creator still hold?</label>
        <div className="row" style={{ gap: 12, marginTop: 4 }}>
          <span className="hint" style={{ margin: 0 }}>More protection</span>
          <input
            type="range" min="0" max="100" step="1"
            value={deployerPct}
            onChange={(e) => onChange({ ...launch, maxDeployerPct: Number(e.target.value) })}
            style={{ flex: 1, accentColor: "var(--amber)" }}
          />
          <span className="hint" style={{ margin: 0 }}>More trades</span>
          <span className="num" style={{ width: 44, textAlign: "right" }}>{deployerPct}%</span>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>{deployerHoldingLabel(deployerPct)}</p>
      </div>
    </div>
  );
}
