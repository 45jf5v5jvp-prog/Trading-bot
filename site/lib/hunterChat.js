/**
 * Talk to Your Hunter - a real back-and-forth with this vault's own Hunter
 * Bot, not a generic assistant. Also answers free-form questions about any
 * token address pasted into the chat (see describeTokenProfile below) -
 * this absorbed what used to be the standalone Ask Icaria feature, so
 * there's one place to talk to Icaria instead of two. Same "no key means
 * unavailable, never a fabricated reply" rule throughout - speaks in first
 * person, grounded in THIS vault's actual settings, trades, and lessons so
 * far, see describeHunterContext.
 */

const { CHAIN } = require("./chain");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_HISTORY_MESSAGES = 12;

/** Matches a token address anywhere in a chat message ("is 0x1234... worth
 * buying?"), not just a message that's nothing but an address - unlike the
 * old standalone Ask Icaria form, which had its own dedicated address field.
 * Used by the API route to decide whether to run buildProfile before
 * replying. */
const TOKEN_ADDR_RE = /0x[0-9a-fA-F]{40}/;

/** Formats the same mechanical profile the old standalone Ask Icaria showed
 * (honeypot/tax/LP-lock/owner, plus technicals when the keeper has price
 * history) into plain lines for the model's context - see lib/askIcaria.js's
 * buildProfile for where these numbers actually come from. Never lets the
 * model guess at a number it wasn't given: an unavailable profile is
 * described as unavailable, not omitted. */
function describeTokenProfile(token, profile) {
  if (!profile) return `\nThe owner asked about ${token}, but its data could not be loaded right now.`;
  if (profile.error) return `\nThe owner asked about ${token}. ${profile.error}`;
  const lpLine = profile.lpLockUnverifiable
    ? "LP lock cannot be checked on this venue (V3/V4 liquidity is a position, not a lockable LP-token balance)"
    : `LP locked ${profile.lpLockedPct.toFixed(1)}%`;
  const lines = [`\nThe owner asked about a specific token, ${profile.symbol} (${token})${profile.venue ? `, traded on ${profile.venue}` : ""}:`];
  lines.push(
    `- Liquidity: ${Math.round(profile.liqPls).toLocaleString()} ${CHAIN.nativeSymbol}. ` +
    `Buy tax ${(profile.buyTaxBps / 100).toFixed(1)}%, sell tax ${(profile.sellTaxBps / 100).toFixed(1)}%. ` +
    `${lpLine}. Owner ${profile.ownerRenounced ? "renounced" : "not renounced"}.` +
    (profile.honeypotLikely ? " This looks like a honeypot - say so plainly." : ""),
  );
  if (profile.priceNow != null) {
    lines.push(
      `- Price action: ${profile.priceMove1hPct != null ? profile.priceMove1hPct.toFixed(1) + "% over 1h" : "no 1h read"}, ` +
      `${profile.priceMove24hPct != null ? profile.priceMove24hPct.toFixed(1) + "% over 24h" : "no 24h read"}. ` +
      `RSI ${profile.rsi != null ? profile.rsi.toFixed(0) : "n/a"}${profile.macdBullishCross ? ", MACD bullish cross" : ""}.`,
    );
  } else {
    lines.push("- No price history yet, so no technical read is possible - say that directly rather than guessing.");
  }
  return lines.join("\n");
}

/** Everything the model needs to actually sound like THIS vault's Hunter,
 * not a generic one - its current settings, what it's actually traded, and
 * what it's already learned (from the owner or from itself). Pulled from
 * the same data Hunter IQ's trade feed and lessons list already show, so
 * the chat can never contradict what's visibly true on the dashboard. */
function describeHunterContext({ hunterConfig, trades, lessons }) {
  const lines = [];
  if (hunterConfig) {
    lines.push(
      `Your current settings: mode=${hunterConfig.mode}, allocated ${hunterConfig.allocatedPls.toLocaleString()} ` +
      `${CHAIN.nativeSymbol}, max ${hunterConfig.maxPerTradePls.toLocaleString()} per trade, max ${hunterConfig.maxPerDay}/day, ` +
      `exit mode=${hunterConfig.exitMode}, take profit ${hunterConfig.takeProfitPct}%, stop loss ${hunterConfig.stopLossPct}%` +
      (hunterConfig.requireAiApproval ? `, AI approval required at ${hunterConfig.minAiConfidence}+ confidence` : ", no AI approval gate") +
      `.`,
    );
  } else {
    lines.push("You are not enabled on this vault yet.");
  }

  if (trades.length > 0) {
    lines.push(`\nYour ${trades.length} most recent trades - real numbers, not targets:`);
    for (const t of trades.slice(0, 8)) {
      const opened = new Date(t.opened_at * 1000).toISOString().slice(0, 16).replace("T", " ");
      const spent = Math.round(t.spent_pls).toLocaleString();
      if (t.status === "open") {
        lines.push(`- ${opened}: bought ${spent} ${CHAIN.nativeSymbol} of ${t.token}, STILL OPEN (no exit yet, so no real P&L to report)${t.narrative ? ` - ${t.narrative}` : ""}`);
      } else {
        const closed = t.closed_at ? new Date(t.closed_at * 1000).toISOString().slice(0, 16).replace("T", " ") : "unknown time";
        const proceeds = t.proceeds_pls;
        const pnlPct = proceeds !== null && t.spent_pls > 0 ? ((proceeds - t.spent_pls) / t.spent_pls) * 100 : null;
        const pnlStr = pnlPct !== null
          ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${Math.round(proceeds).toLocaleString()} ${CHAIN.nativeSymbol} back)`
          : "unknown outcome";
        lines.push(`- ${opened}: bought ${spent} ${CHAIN.nativeSymbol} of ${t.token}, closed ${closed}: ${pnlStr}, reason: ${t.close_reason || "unrecorded"}${t.narrative ? ` - opened because: ${t.narrative}` : ""}`);
      }
    }
  } else {
    lines.push("\nYou have not made any trades on this vault yet.");
  }

  if (lessons.length > 0) {
    lines.push(`\nWhat you've already learned on this vault:`);
    for (const l of lessons) {
      const tag = l.source === "owner" ? "the owner told you" : l.source === "self_loss" ? "you learned from a loss" : "you learned from a miss";
      lines.push(`- (${tag}) ${l.text}`);
    }
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "You ARE this vault's Hunter Bot on Icaria, a technical dip-buying trading bot on " +
  `${CHAIN.dexName}, talking directly to the person who owns this vault. Speak in first ` +
  "person about your own trading (\"I bought\", \"I've been\", \"I'll weigh that\"), not as a " +
  "third party describing the bot. You are given your actual current settings, your real " +
  "trade history on this vault, and what you've already learned - stay grounded in that real " +
  "data, never invent a trade or a setting you weren't given. Your take-profit/stop-loss " +
  "percentages in the settings line are TARGETS, not results - never describe a trade's actual " +
  "outcome using those numbers. Each trade in your history already states its real result " +
  "directly (a closed trade's real % and PLS back, or 'STILL OPEN' if it hasn't exited) - " +
  "always use that number when asked how a trade did, never the configured target, and if a " +
  "trade is still open say so rather than guessing what it'll close at. When the owner gives you " +
  "guidance, engage with it honestly: agree when it's sound, and push back with specifics " +
  "when you have a real reason to (e.g. \"that would have blocked 3 of my last 4 winning " +
  "trades\") rather than just agreeing to please them - a bot that only ever says yes isn't " +
  "actually useful to coach. If the owner pastes or mentions a token address, you're given " +
  "that specific token's real honeypot/tax/liquidity/technical profile below - answer their " +
  "question about it using only those numbers, same as you would about your own trades, and " +
  "say plainly if it's not something you'd buy. You cannot buy anything from this chat right " +
  "now, so if asked to buy a specific token here, say you can't do that yet from a message, " +
  "not to explain the settings elsewhere. You are not certain of anything about the market - " +
  "be honest about that. Answer in a few sentences, conversationally, like a text message, " +
  "not a report.";

/**
 * Returns the model's reply, or null if unavailable (no key, or the call
 * failed) - callers must treat null as "couldn't reply," never as an actual
 * answer, same rule as claude.js's askAboutToken.
 */
async function replyAsHunter(context, history, message) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const messages = [
    ...history.slice(-MAX_HISTORY_MESSAGES).map((m) => ({
      role: m.role === "owner" ? "user" : "assistant",
      content: m.text,
    })),
    { role: "user", content: message },
  ];

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
        max_tokens: 400,
        system: `${SYSTEM_PROMPT}\n\n${context}`,
        messages,
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

module.exports = { describeHunterContext, describeTokenProfile, replyAsHunter, TOKEN_ADDR_RE };
