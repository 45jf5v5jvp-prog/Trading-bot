import { useState } from "react";
import { askQuestion } from "../lib/askQuestion";
import { buyFromAsk } from "../lib/buyFromAsk";
import { CHAIN } from "../lib/contracts";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Ask Icaria about any token address - "is this a good move?" Runs the same
 * mechanical honeypot/tax/LP-lock checks every bot here runs, always shown,
 * plus a plain-English AI read on top when configured. "Buy it" is a
 * separate signed step; nothing here ever spends anything on its own.
 */
export default function AskIcaria({ vaultAddress, getProvider }) {
  const [token, setToken] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState(null); // { profile, answer, error }
  const [askError, setAskError] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const [buyState, setBuyState] = useState(""); // "" | "pending" | "requested" | "error"
  const [buyError, setBuyError] = useState("");

  async function handleAsk() {
    setAskError("");
    if (!ADDR_RE.test(token.trim())) { setAskError("Enter a valid 0x token address."); return; }
    if (!question.trim()) { setAskError("Ask a question first."); return; }
    setAsking(true);
    setResult(null);
    try {
      const body = await askQuestion(vaultAddress, token.trim(), question.trim());
      setResult(body);
    } catch (e) {
      setAskError(e.message);
    } finally {
      setAsking(false);
    }
  }

  async function handleBuy() {
    setBuyError("");
    const amt = Number(buyAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setBuyError("Enter a positive amount."); return; }
    setBuyState("pending");
    try {
      await buyFromAsk(getProvider, vaultAddress, result.profile.token, amt);
      setBuyState("requested");
    } catch (e) {
      setBuyState("error");
      setBuyError(e.message);
    }
  }

  const profile = result?.profile;
  const canBuy = profile && profile.sellable && !profile.honeypotLikely;

  return (
    <div>
      <div className="section-label">Ask Icaria</div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Paste any token address on {CHAIN.dexName} and ask about it - "is this a good move?" Runs
        the same honeypot/tax/LP-lock screen every bot here runs, always shown, plus a plain-English
        read from Claude on top when it's configured. Buying is a separate step you approve yourself.
      </p>

      <div className="field-inline">
        <label>Token address</label>
        <input
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="0x..."
          style={{ width: 320, fontFamily: "monospace" }}
        />
      </div>
      <div className="field-inline">
        <label>Question</label>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Is this a good move?"
          style={{ width: 320 }}
        />
      </div>
      <button type="button" className="btn btn-small" onClick={handleAsk} disabled={asking} style={{ marginTop: 6 }}>
        {asking ? "Asking..." : "Ask"}
      </button>
      {askError && <p className="hint" style={{ color: "var(--red, #c0392b)" }}>{askError}</p>}

      {result?.error && (
        <p className="hint" style={{ marginTop: 12, color: "var(--red, #c0392b)" }}>{result.error}</p>
      )}

      {profile && (
        <div className="dead-position-row" style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <span className="holding-token" style={{ fontSize: 12.5 }}>{profile.symbol}</span>
            {profile.venue && (
              <span className="hint" style={{ margin: 0, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 10 }}>
                {profile.venue}
              </span>
            )}
            {profile.honeypotLikely && <span style={{ color: "var(--red, #c0392b)", fontSize: 12 }}>looks like a honeypot</span>}
          </div>
          <p className="hint" style={{ margin: 0 }}>
            {profile.liqPls > 0 && <>Liquidity {Math.round(profile.liqPls).toLocaleString()} {CHAIN.nativeSymbol} · </>}
            buy tax {(profile.buyTaxBps / 100).toFixed(1)}%
            · sell tax {(profile.sellTaxBps / 100).toFixed(1)}%
            · LP locked {profile.lpLockUnverifiable ? "cannot be verified for this venue" : `${profile.lpLockedPct.toFixed(1)}%`}
            · owner {profile.ownerRenounced ? "renounced" : "not renounced"}
          </p>
          {result.answer ? (
            <p className="hint" style={{ marginTop: 8 }}>{result.answer}</p>
          ) : (
            <p className="hint" style={{ marginTop: 8, fontStyle: "italic" }}>
              No AI read available (ANTHROPIC_API_KEY not configured on this deployment yet) - the
              mechanical checks above are still accurate.
            </p>
          )}

          {canBuy ? (
            <div className="field-inline" style={{ marginTop: 10 }}>
              <label>{CHAIN.nativeSymbol} to spend</label>
              <input
                type="number" min="0" value={buyAmount}
                onChange={(e) => setBuyAmount(e.target.value)}
                style={{ width: 110 }}
              />
              <button
                type="button" className="btn btn-small" onClick={handleBuy}
                disabled={buyState === "pending" || buyState === "requested"}
              >
                {buyState === "pending" ? "..." : buyState === "requested" ? "Requested" : "Buy it"}
              </button>
            </div>
          ) : (
            <p className="hint" style={{ marginTop: 8, color: "var(--red, #c0392b)" }}>
              Not buyable - this token failed the sellability check.
            </p>
          )}
          {buyError && <p className="hint" style={{ color: "var(--red, #c0392b)" }}>{buyError}</p>}
        </div>
      )}
    </div>
  );
}
