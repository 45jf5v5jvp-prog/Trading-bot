import { numberFieldProps } from "../lib/numberField";
import { CHAIN } from "../lib/contracts";

/**
 * Editor for Hunter Bot settings. Hunts RSI/MACD/Bollinger dip-buying setups
 * across every watched token, trading a dedicated slice of the vault
 * (allocated PLS) rather than the whole balance. A liquidity-coherence check
 * (always on, not a setting here) rejects a dip whose liquidity fell more
 * than the price move alone explains - the "price cratered because LP got
 * pulled, looks like a buyable dip" trap this bot exists to avoid.
 */
export default function HunterSettings({ hunter, onChange }) {
  const num = (field) => numberFieldProps(hunter[field] ?? 0, (v) => onChange({ ...hunter, [field]: v }));

  return (
    <div>
      <div className="section-label">Hunter Bot</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Hunts for oversold dip-buying setups on {CHAIN.dexName} using technical indicators (RSI,
        MACD, Bollinger Bands), instead of reacting to a new launch or a price/liquidity breakout.
        Trades a dedicated slice of the vault you choose, not the whole balance. Every candidate
        still runs the full honeypot/tax/LP-lock/renounce screen, plus a check that catches a price
        crash caused by liquidity being pulled before it's mistaken for a real dip.
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
        <label>Max {CHAIN.nativeSymbol} per buy</label>
        <input {...num("maxPerTradePls")} min="0" style={{ width: 100 }} />
        <label>Max buys/day</label>
        <input {...num("maxPerDay")} min="0" style={{ width: 80 }} />
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        Hunter Bot never has more than "Allocated" deployed at once across its own open positions -
        it's the amount you're choosing to risk on this bot specifically, separate from the rest of
        the vault. Freed back up as positions close, win or lose, so it can keep reusing that amount.
        "Max per buy" is a ceiling, not a fixed size - with AI approval on, the AI decides how much
        of that ceiling to actually spend on each buy (less when it's less confident), full authority
        up to the number you set here, never more.
      </p>

      <div className="sub-label">Technical setup (at least one enabled trigger must fire)</div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireRsi} onChange={(e) => onChange({ ...hunter, requireRsi: e.target.checked })} />
        RSI oversold, at or below
        <input {...num("rsiOversold")} min="0" max="100" style={{ width: 70 }} disabled={!hunter.requireRsi} />
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireMacdCross} onChange={(e) => onChange({ ...hunter, requireMacdCross: e.target.checked })} />
        A bullish MACD crossover just occurred
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireBollinger} onChange={(e) => onChange({ ...hunter, requireBollinger: e.target.checked })} />
        Bollinger %B at or below
        <input
          {...numberFieldProps(hunter.bollingerPercentBMax ?? 0, (v) => onChange({ ...hunter, bollingerPercentBMax: v }))}
          min="0" max="1" step="0.01" style={{ width: 70 }} disabled={!hunter.requireBollinger}
        />
        <span className="hint" style={{ margin: 0 }}>(0 = lower band, 1 = upper band)</span>
      </label>

      <div className="field-inline">
        <label>Min liquidity ({CHAIN.nativeSymbol})</label>
        <input {...num("minLiquidityPls")} min="0" style={{ width: 110 }} />
      </div>

      <div className="sub-label">AI judgment gate</div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "10px 0" }}>
        <input type="checkbox" checked={hunter.requireAiApproval} onChange={(e) => onChange({ ...hunter, requireAiApproval: e.target.checked })} />
        Require AI approval before auto-buying
      </label>
      <div className="field-inline">
        <label>Minimum confidence</label>
        <select
          value={hunter.minAiConfidence}
          onChange={(e) => onChange({ ...hunter, minAiConfidence: e.target.value })}
          style={{ width: 120 }}
          disabled={!hunter.requireAiApproval}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        A technical setup and a passed screen are not enough to auto-buy - a Claude API call judges
        the whole picture first. With no key configured on the keeper this fails safe: it notifies
        you instead of buying, it never buys blind.
      </p>

      <div className="sub-label">Exits</div>

      <div className="field-inline">
        <label>Exit mode</label>
        <select
          value={hunter.exitMode}
          onChange={(e) => onChange({ ...hunter, exitMode: e.target.value })}
          style={{ width: 160 }}
        >
          <option value="limited">Auto Limited</option>
          <option value="full">Auto Full</option>
        </select>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        {hunter.exitMode === "full"
          ? "Auto Full gives the AI ongoing authority to decide when to exit - it re-checks each open position and can ride a winner past what a fixed target would have locked in. The stop loss below still applies no matter what it decides; take profit, trailing stop, and time exit are not used in this mode."
          : "Auto Limited exits at the fixed targets below, same as every other bot here. Switch to Auto Full to hand the AI ongoing authority over when to exit instead."}
      </p>

      <div className="field-inline">
        {hunter.exitMode === "limited" && (
          <>
            <label>Take profit %</label>
            <input {...num("takeProfitPct")} min="0" style={{ width: 80 }} />
          </>
        )}
        <label>Stop loss %{hunter.exitMode === "full" ? " (mandatory floor)" : ""}</label>
        <input {...num("stopLossPct")} min="0" style={{ width: 80 }} />
        {hunter.exitMode === "limited" && (
          <>
            <label>Time exit (min)</label>
            <input {...num("timeExitMin")} min="0" style={{ width: 80 }} />
          </>
        )}
      </div>

      {hunter.exitMode === "limited" && (
        <div className="field-inline">
          <label>Trailing stop %</label>
          <input {...num("trailingStopPct")} min="0" style={{ width: 80 }} />
        </div>
      )}

      <div className="sub-label">Screening limits (a token failing any of these is never buyable, notify or auto-buy)</div>

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
