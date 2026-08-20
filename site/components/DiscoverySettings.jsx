import { numberFieldProps } from "../lib/numberField";
import { CHAIN } from "../lib/contracts";

/**
 * Editor for Discovery Bot settings. Unlike the Launch Bot (reacts to a
 * brand-new pair) or a snipe/rule (reacts to one named token), this watches
 * every token the keeper has ever seen for a price move and a liquidity
 * increase happening together - the signal that real buying is happening,
 * not a wash-traded pump. Every candidate still runs the full honeypot/tax/
 * LP-lock/renounce screen before anything is shown as buyable or bought.
 */
export default function DiscoverySettings({ discovery, onChange }) {
  const num = (field) => numberFieldProps(discovery[field] ?? 0, (v) => onChange({ ...discovery, [field]: v }));

  return (
    <div>
      <div className="section-label">Discovery Bot</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Scans all of {CHAIN.dexName} on {CHAIN.chainName} - not just new launches - for tokens whose price
        and liquidity are both climbing together over the last hour. Notify mode shows them in the
        Opportunities panel below with a Buy Now button; Auto-buy mode buys automatically.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={discovery.enabled} onChange={(e) => onChange({ ...discovery, enabled: e.target.checked })} />
        {discovery.enabled ? "Discovery Bot is ON" : "Discovery Bot is OFF - settings are saved but it will not scan for you"}
      </label>

      <div className="field-inline">
        <label>Mode</label>
        <select
          value={discovery.mode}
          onChange={(e) => onChange({ ...discovery, mode: e.target.value })}
          style={{ width: 140 }}
        >
          <option value="notify">Notify only</option>
          <option value="autoBuy">Auto-buy</option>
        </select>
      </div>

      <div className="field-inline">
        <label>{CHAIN.nativeSymbol} per buy</label>
        <input {...num("amountPls")} min="0" style={{ width: 100 }} />
        <label>Max buys/day</label>
        <input {...num("maxPerDay")} min="0" style={{ width: 80 }} />
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        In notify mode this amount is also what a "Buy Now" click spends - it's the size you'd
        want on any Discovery Bot buy, automatic or manual.
      </p>

      <div className="sub-label">Detection thresholds (over the last hour)</div>

      <div className="field-inline">
        <label>Min price move %</label>
        <input {...num("minPriceMovePct")} min="0" style={{ width: 90 }} />
        <label>Min liquidity growth %</label>
        <input {...num("minLiquidityGrowthPct")} min="0" style={{ width: 90 }} />
      </div>

      <div className="field-inline">
        <label>Min liquidity ({CHAIN.nativeSymbol})</label>
        <input {...num("minLiquidityPls")} min="0" style={{ width: 110 }} />
      </div>

      <div className="field-inline">
        <label>Take profit %</label>
        <input {...num("takeProfitPct")} min="0" style={{ width: 80 }} />
        <label>Stop loss %</label>
        <input {...num("stopLossPct")} min="0" style={{ width: 80 }} />
        <label>Time exit (min)</label>
        <input {...num("timeExitMin")} min="0" style={{ width: 80 }} />
      </div>

      <div className="field-inline">
        <label>Trailing stop %</label>
        <input {...num("trailingStopPct")} min="0" style={{ width: 80 }} />
      </div>

      <div className="sub-label">Screening limits (a token failing any of these is never buyable, notify or auto-buy)</div>

      <div className="field-inline">
        <label>Max buy tax (bps)</label>
        <input {...num("maxBuyTaxBps")} min="0" style={{ width: 90 }} />
        <label>Max sell tax (bps)</label>
        <input {...num("maxSellTaxBps")} min="0" style={{ width: 90 }} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={discovery.requireLpLock} onChange={(e) => onChange({ ...discovery, requireLpLock: e.target.checked })} />
        Require LP locked/burned
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={discovery.requireOwnerRenounced} onChange={(e) => onChange({ ...discovery, requireOwnerRenounced: e.target.checked })} />
        Require ownership renounced
      </label>
      <p className="hint" style={{ marginTop: -6 }}>
        There's no deployer-share check here, unlike the Launch Bot - a token discovered this way
        has no deployer address on file, only ones seen brand new at launch do.
      </p>
    </div>
  );
}
