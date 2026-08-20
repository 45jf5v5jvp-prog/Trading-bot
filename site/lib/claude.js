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
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "You assess PulseChain (PulseX) tokens for a trading bot's users, answering a question the " +
  "user typed themselves about a specific token address they chose. You are given the token's " +
  "mechanical profile - a honeypot/sellability simulation, tax, and LP-lock check already ran " +
  "before you were called, so don't re-derive those, just use them. Your job is judgment the " +
  "numbers alone don't cover: does the overall picture look like real organic interest, or " +
  "engineered/suspicious? You are not certain of anything - a token can turn hostile in the " +
  "next block, and past behavior predicts nothing. Say so when relevant. Never claim a trade is " +
  "safe, only that it looks reasonable or does not, and why. Answer in a few sentences, plainly.";

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
