import { numberFieldProps } from "../lib/numberField";
import { CHAIN } from "../lib/contracts";

const CONFIDENCE_LABEL = { low: "Low or better", medium: "Medium or better", high: "High only" };

/**
 * Editor for Hunter Bot settings. Hunts RSI/MACD/Bollinger dip-buying
 * setups across every watched token, trading a dedicated slice of the vault
 * (allocatedPls) rather than the whole balance. The liquidity-coherence
 * check that catches a liquidity pull masquerading as a dip is always on -
 * there's no setting for it here on purpose, see keeper/src/registry.ts's
 * HunterConfig comment.
 */
export default function HunterSettings({ hunter, onChange }) {
  const num = (field) => numberFieldProps(hunter[field] ?? 0, (v) => onChange({ ...hunter, [field]: v }));

  return (
    <div>
      <div className="section-label">Hunter Bot</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Watches every token on {CHAIN.dexName} for a technical dip-buying setup - RSI oversold, a
        bullish MACD cross, or a Bollinger lower-band touch - and trades a dedicated slice of your
        vault against it, never the whole balance. Every candidate still runs the same honeypot/tax/
        LP-lock/renounce screen the Launch Bot runs, plus a hard liquidity-coherence check (always on)
        that catches a token whose price cratered because its liquidity was pulled, not because it
        actually dipped.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={hunter.enabled} onChange={(e) => onChange({ ...hunter, enabled: e.target.checked })} />
        {hunter.enabled ? "Hunter Bot is ON" : "Hunter Bot is OFF - settings are saved but it will not hunt for you"}
      </label>

      <div className="field-inline">
        <label>Mode</label>
        <select
          value={hunter.mode}
          onChange={(e) => onChange({ ...hunter, mode: e.target.value })}
          style={{ width: 140 }}
        >
          <option value="notify">Notify only</option>
          <option value="autoBuy">Auto-buy</option>
        </select>
      </div>

      <div className="field-inline">
        <label>Allocated {CHAIN.nativeSymbol}</label>
        <input {...num("allocatedPls")} min="0" style={{ width: 110 }} />
        <label>Max per trade ({CHAIN.nativeSymbol})</label>
        <input {...num("maxPerTradePls")} min="0" style={{ width: 100 }} />
        <label>Max buys/day</label>
        <input {...num("maxPerDay")} min="0" style={{ width: 80 }} />
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        Allocated {CHAIN.nativeSymbol} is a dedicated bankroll - Hunter Bot never has more than this
        deployed across its own open positions at once, freed back as they close. Max per trade is a
        ceiling, not a fixed size: when an AI gate is required below, the AI decides how much of that
        ceiling to actually spend; otherwise it spends the full ceiling every time.
      </p>

      <div className="sub-label">Triggers (at least one must fire)</div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireRsi} onChange={(e) => onChange({ ...hunter, requireRsi: e.target.checked })} />
        RSI oversold
      </label>
      <div className="field-inline">
        <label>RSI(14) at or below</label>
        <input {...num("rsiOversold")} min="0" max="100" style={{ width: 80 }} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireMacdCross} onChange={(e) => onChange({ ...hunter, requireMacdCross: e.target.checked })} />
        Bullish MACD cross just occurred
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireBollinger} onChange={(e) => onChange({ ...hunter, requireBollinger: e.target.checked })} />
        Riding the Bollinger lower band
      </label>
      <div className="field-inline">
        <label>Bollinger %B at or below</label>
        <input {...num("bollingerPercentBMax")} min="0" max="1" step="0.01" style={{ width: 80 }} />
      </div>

      <div className="sub-label">AI gate</div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireAiApproval} onChange={(e) => onChange({ ...hunter, requireAiApproval: e.target.checked })} />
        Require AI approval before auto-buying
      </label>
      <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
        With no AI key configured on the keeper, a required AI gate fails safe - it notifies instead
        of buying, never buys unapproved. The AI also decides how much of the max-per-trade ceiling
        to actually spend when it recommends a buy.
      </p>
      <div className="field-inline">
        <label>Minimum AI confidence</label>
        <select
          value={hunter.minAiConfidence}
          onChange={(e) => onChange({ ...hunter, minAiConfidence: e.target.value })}
          style={{ width: 160 }}
        >
          {Object.entries(CONFIDENCE_LABEL).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      </div>

      <div className="sub-label">Exit mode</div>
      <div className="field-inline">
        <label>Exit mode</label>
        <select
          value={hunter.exitMode}
          onChange={(e) => onChange({ ...hunter, exitMode: e.target.value })}
          style={{ width: 160 }}
        >
          <option value="limited">Auto Limited (fixed targets)</option>
          <option value="full">Auto Full (AI decides)</option>
        </select>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
        {hunter.exitMode === "full"
          ? "Auto Full: the AI periodically re-judges each open position and can hold past a fixed " +
            "target if it still looks worth holding. The stop-loss below always still applies underneath - " +
            "the AI can never remove it."
          : "Auto Limited: take-profit, stop-loss, trailing stop, and time exit below apply exactly as set, " +
            "the same fixed-target exit every other bot here uses."}
      </p>

      {hunter.exitMode === "limited" && (
        <>
          <div className="field-inline">
            <label>Take profit %</label>
            <input {...num("takeProfitPct")} min="0" style={{ width: 80 }} />
            <label>Time exit (min)</label>
            <input {...num("timeExitMin")} min="0" style={{ width: 80 }} />
          </div>
          <div className="field-inline">
            <label>Trailing stop %</label>
            <input {...num("trailingStopPct")} min="0" style={{ width: 80 }} />
          </div>
        </>
      )}
      <div className="field-inline">
        <label>Stop loss %{hunter.exitMode === "full" ? " (mandatory floor)" : ""}</label>
        <input {...num("stopLossPct")} min="0" style={{ width: 80 }} />
      </div>
      {hunter.exitMode === "full" && (
        <p className="hint" style={{ marginTop: -6 }}>
          Auto Full still needs a real stop-loss here - if left at 0 the keeper enforces a 50% floor
          underneath regardless, but setting your own tighter number is safer than relying on that default.
        </p>
      )}

      <div className="sub-label">Screening limits (a token failing any of these is never buyable, notify or auto-buy)</div>

      <div className="field-inline">
        <label>Min liquidity ({CHAIN.nativeSymbol})</label>
        <input {...num("minLiquidityPls")} min="0" style={{ width: 110 }} />
      </div>

      <div className="field-inline">
        <label>Max buy tax (bps)</label>
        <input {...num("maxBuyTaxBps")} min="0" style={{ width: 90 }} />
        <label>Max sell tax (bps)</label>
        <input {...num("maxSellTaxBps")} min="0" style={{ width: 90 }} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireLpLock} onChange={(e) => onChange({ ...hunter, requireLpLock: e.target.checked })} />
        Require LP locked/burned
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireOwnerRenounced} onChange={(e) => onChange({ ...hunter, requireOwnerRenounced: e.target.checked })} />
        Require ownership renounced
      </label>
    </div>
  );
}
