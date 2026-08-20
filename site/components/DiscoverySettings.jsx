import { useState } from "react";
import { numberFieldProps } from "../lib/numberField";
import { CHAIN } from "../lib/contracts";

/**
 * Three questions map to a full Discovery Bot config. Each answer only ever
 * touches trading-STYLE fields (how big a move counts as worth acting on,
 * how fast to take profit/cut losses, how much to risk per trade) - never
 * the honeypot/tax/LP-lock/renounce screen, which stays exactly as strict
 * regardless of how someone wants to trade. Turning the dial toward "trade
 * often" makes the bot MORE SENSITIVE to smaller moves, which is the only
 * honest lever that can increase trade frequency - it cannot manufacture
 * opportunities that real market activity on the chain doesn't produce.
 */
const STYLE_PRESETS = {
  frequent: {
    label: "Many trades, smaller gains",
    detail: "Reacts to smaller moves (5%+) and takes profit fast at 8%, freeing capital to redeploy. More trades, each one worth less.",
    minPriceMovePct: 5, minLiquidityGrowthPct: 8, takeProfitPct: 8, trailingStopPct: 3, timeExitMin: 45, maxPerDay: 60,
  },
  balanced: {
    label: "Balanced",
    detail: "Reacts to a clearer move (12%+), holds for a 20% target with room to trail. A middle ground between the other two.",
    minPriceMovePct: 12, minLiquidityGrowthPct: 12, takeProfitPct: 20, trailingStopPct: 8, timeExitMin: 90, maxPerDay: 15,
  },
  patient: {
    label: "Fewer trades, bigger gains",
    detail: "Only reacts to a strong move (25%+), holds for a 45% target. Trades far less often, each one aimed at a much bigger swing.",
    minPriceMovePct: 25, minLiquidityGrowthPct: 20, takeProfitPct: 45, trailingStopPct: 15, timeExitMin: 240, maxPerDay: 5,
  },
};

const RISK_PRESETS = {
  tight: { label: "Cut losses fast", detail: "Exits a losing position at -12%.", stopLossPct: 12 },
  moderate: { label: "Moderate", detail: "Exits a losing position at -22%.", stopLossPct: 22 },
  loose: { label: "Give it room", detail: "Exits a losing position at -35%.", stopLossPct: 35 },
};

const SIZE_PRESETS = {
  small: { label: "Small bites", detail: "3% of your current balance per trade - more positions open at once.", pct: 0.03 },
  medium: { label: "Medium", detail: "7% of your current balance per trade.", pct: 0.07 },
  large: { label: "Large bites", detail: "15% of your current balance per trade - fewer, bigger positions.", pct: 0.15 },
};

function ChoiceGroup({ options, value, onSelect }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
      {Object.entries(options).map(([key, opt]) => (
        <button
          key={key}
          type="button"
          className={value === key ? "btn btn-primary" : "btn"}
          style={{ textAlign: "left", padding: "10px 14px", height: "auto", textTransform: "none", letterSpacing: 0 }}
          onClick={() => onSelect(key)}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</div>
          <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 2, fontWeight: 400 }}>{opt.detail}</div>
        </button>
      ))}
    </div>
  );
}

/**
 * Quick Setup: three questions instead of nine raw fields, for turning Auto
 * mode on with sane numbers instead of guessing at what "min price move %"
 * or "trailing stop %" should be. Writes into the SAME config object the
 * manual fields below edit - nothing hidden, nothing that bypasses saving -
 * so the resulting numbers are visible and still hand-tunable afterward.
 */
function QuickSetup({ discovery, onChange, vaultBalance }) {
  const [style, setStyle] = useState(null);
  const [risk, setRisk] = useState(null);
  const [size, setSize] = useState(null);
  const ready = style && risk && size;
  const amountPls = ready ? Math.round(vaultBalance * SIZE_PRESETS[size].pct) : 0;

  function apply() {
    const s = STYLE_PRESETS[style];
    const r = RISK_PRESETS[risk];
    onChange({
      ...discovery,
      enabled: true,
      mode: "autoBuy",
      amountPls,
      maxPerDay: s.maxPerDay,
      minPriceMovePct: s.minPriceMovePct,
      minLiquidityGrowthPct: s.minLiquidityGrowthPct,
      takeProfitPct: s.takeProfitPct,
      trailingStopPct: s.trailingStopPct,
      timeExitMin: s.timeExitMin,
      stopLossPct: r.stopLossPct,
    });
  }

  return (
    <div className="rule-panel" style={{ marginBottom: 18 }}>
      <div className="sub-label" style={{ marginTop: 0 }}>Quick Setup: how do you want this to trade?</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Three questions, then it sets the fields below for you (still fully editable after). This
        tunes how sensitive the bot is to a move and how it manages each trade - it cannot make more
        real opportunities exist than {CHAIN.dexName} actually produces on a given day, and the
        honeypot/tax/LP-lock screen below is never affected by any of this.
      </p>

      <p className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>1. Would you rather...</p>
      <ChoiceGroup options={STYLE_PRESETS} value={style} onSelect={setStyle} />

      <p className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>2. How much room should a losing trade get?</p>
      <ChoiceGroup options={RISK_PRESETS} value={risk} onSelect={setRisk} />

      <p className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>3. How big should each trade be?</p>
      <ChoiceGroup options={SIZE_PRESETS} value={size} onSelect={setSize} />

      {ready && (
        <>
          <p className="hint" style={{ marginBottom: 10 }}>
            This sets: {amountPls.toLocaleString()} {CHAIN.nativeSymbol} per trade, up to{" "}
            {STYLE_PRESETS[style].maxPerDay} trades/day, take profit at {STYLE_PRESETS[style].takeProfitPct}%,
            stop loss at {RISK_PRESETS[risk].stopLossPct}%, and turns Discovery Bot ON in Auto-buy mode.
            {amountPls <= 0 && " Your vault balance is 0, so this won't actually trade until you deposit."}
          </p>
          <button type="button" className="btn btn-primary" onClick={apply}>
            Apply and turn on Auto-Buy
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Editor for Discovery Bot settings. Unlike the Launch Bot (reacts to a
 * brand-new pair) or a snipe/rule (reacts to one named token), this watches
 * every token the keeper has ever seen for a price move and a liquidity
 * increase happening together - the signal that real buying is happening,
 * not a wash-traded pump. Every candidate still runs the full honeypot/tax/
 * LP-lock/renounce screen before anything is shown as buyable or bought.
 */
export default function DiscoverySettings({ discovery, onChange, vaultBalance = 0 }) {
  const num = (field) => numberFieldProps(discovery[field] ?? 0, (v) => onChange({ ...discovery, [field]: v }));

  return (
    <div>
      <div className="section-label">Discovery Bot</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Scans all of {CHAIN.dexName} on {CHAIN.chainName} - not just new launches - for tokens whose price
        and liquidity are both climbing together over the last hour. Notify mode shows them in the
        Opportunities panel below with a Buy Now button; Auto-buy mode buys automatically.
      </p>

      <QuickSetup discovery={discovery} onChange={onChange} vaultBalance={vaultBalance} />

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
        In notify mode this amount is also what a "Buy Now" click spends by default - Buy Now lets
        you type a different amount at the time instead, if you'd rather.
      </p>

      <div className="sub-label">Detection thresholds (over the last hour)</div>

      <div className="field-inline">
        <label>Min price move %</label>
        <input {...num("minPriceMovePct")} min="0" style={{ width: 90 }} />
        <label>Min liquidity growth %</label>
        <input {...num("minLiquidityGrowthPct")} min="0" style={{ width: 90 }} />
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        Lower thresholds catch smaller, more frequent moves - more trades, each less certain. Higher
        thresholds wait for a clearer signal - fewer trades, each more convincing.
      </p>

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
