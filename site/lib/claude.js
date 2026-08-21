/**
 * Thin wrapper around the Claude API for Ask Icaria's free-form answers.
 * Mirrors keeper/src/ai.ts's shape (same model default, same "no key means
 * unavailable, never a fabricated answer" rule) but lives here separately -
 * the site and keeper are separate deployments with separate .env files, so
 * this needs its own ANTHROPIC_API_KEY set on the site too.
 */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

function describeProfile(p) {
  const lines = [
    `Token: ${p.symbol} (${p.token})`,
    `Liquidity: ${Math.round(p.liqPls).toLocaleString()} PLS`,
    `Buy tax: ${(p.buyTaxBps / 100).toFixed(1)}%, sell tax: ${(p.sellTaxBps / 100).toFixed(1)}%`,
    `Round trip buy+sell loses ${p.roundTripLossBps} bps beyond tax (slippage/other friction)`,
    `Sellable: ${p.sellable ? "yes" : "no - this looks like a honeypot"}`,
    `LP locked or burned: ${p.lpLockedPct.toFixed(1)}%`,
    `Owner renounced: ${p.ownerRenounced ? "yes" : "no - owner retains privileged control"}`,
  ];
  if (p.priceNow != null) {
    lines.push(`Current price: ${p.priceNow} PLS per token (${p.historyHours.toFixed(1)}h of price history on file)`);
    if (p.priceMove1hPct != null) lines.push(`Price moved ${p.priceMove1hPct >= 0 ? "+" : ""}${p.priceMove1hPct.toFixed(1)}% in the last hour`);
    if (p.priceMove24hPct != null) lines.push(`Price moved ${p.priceMove24hPct >= 0 ? "+" : ""}${p.priceMove24hPct.toFixed(1)}% in the last 24 hours`);
    if (p.rsi != null) lines.push(`RSI(14): ${p.rsi.toFixed(0)} ${p.rsi < 30 ? "(oversold)" : p.rsi > 70 ? "(overbought)" : ""}`);
    if (p.macdHistogram != null)
      lines.push(`MACD histogram: ${p.macdHistogram.toFixed(4)}${p.macdBullishCross ? " (bullish cross just occurred)" : ""}`);
    if (p.bollingerPercentB != null) lines.push(`Bollinger %B: ${p.bollingerPercentB.toFixed(2)} (0 = lower band, 1 = upper band)`);
    if (p.atrPct != null) lines.push(`ATR(14): ${p.atrPct.toFixed(1)}% of price (how much this token normally moves)`);
    if (p.volRatio != null && Number.isFinite(p.volRatio)) lines.push(`Recent volume vs. this token's own baseline: ${p.volRatio.toFixed(1)}x`);
  } else {
    lines.push(
      "Price history: NONE ON FILE YET. The keeper hasn't been watching this token long enough " +
      "to have a price read - say so plainly rather than guessing at price action or technicals.",
    );
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "You assess PulseChain (PulseX) tokens for a trading bot's users, answering a question the " +
  "user typed themselves about a specific token address they chose. You are given the token's " +
  "mechanical profile - a honeypot/sellability simulation, tax, and LP-lock check already ran " +
  "before you were called, so don't re-derive those, just use them. When the user asks something " +
  "like 'is this a good buy right now' or 'do the technicals look good,' answer that DIRECTLY " +
  "using the price action and indicators in the profile (current price, recent % move, RSI, MACD, " +
  "Bollinger %B, ATR, volume vs. baseline) - don't retreat into only tax/LP/renounce facts when " +
  "price data is available; that's not what they asked. The whole point is helping them decide " +
  "with data instead of buying blind, so always state plainly whether the technicals actually " +
  "support entering now: if they do, say what's lining up (e.g. oversold RSI plus a bullish MACD " +
  "cross) and that it looks like a reasonable entry; if they don't, say directly that this doesn't " +
  "look like a good time to enter given how the technicals look right now, and name what's missing " +
  "or working against it (e.g. RSI neutral, no volume confirmation, price still falling). If no " +
  "price history is on file yet, say so plainly instead of guessing. Beyond the numbers, your job " +
  "is judgment the numbers alone don't cover: does the overall picture look like real organic " +
  "interest, or engineered/suspicious? You are not certain of anything - a token can turn hostile " +
  "in the next block, and past price action predicts nothing about the next candle. Say so when " +
  "relevant. Never claim a trade is safe, only that it looks reasonable or does not, and why. " +
  "Answer in a few sentences, plainly, citing the actual numbers you're using.";

/** Returns the model's text answer, or null if unavailable (no key, or the
 * call failed) - callers must treat null as "couldn't ask," never as an
 * answer of any kind. */
async function askAboutToken(profile, question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `${describeProfile(profile)}\n\nThe user asks: "${question}"`,
        }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlock = (data.content ?? []).find((b) => b.type === "text");
    return textBlock?.text ?? null;
  } catch {
    return null;
  }
}

module.exports = { askAboutToken };
