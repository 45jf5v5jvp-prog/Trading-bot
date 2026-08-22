import { CFG } from "./config.js";
import { log } from "./log.js";

/**
 * Thin wrapper around the Claude API. Shared by two callers:
 *
 *   - hunter.ts's AI gate: a technical setup (RSI/MACD/Bollinger) already
 *     triggered and the token already passed the standard honeypot/tax/LP
 *     screen. Before spending real money, ask a model to sanity-check the
 *     whole picture - it can catch things pure thresholds miss (a pattern
 *     that technically clears every number but reads as engineered, a
 *     narrative mismatch between the token's name and its trading pattern).
 *   - Ask Icaria (site-side): a free-form "should I buy this" question about
 *     a token the user picked themselves.
 *
 * Deliberately NOT a replacement for the screen. Both callers still run the
 * full honeypot/tax/LP-lock simulation first - this only ever sees a token
 * that already cleared that bar, and its job is to catch what the numbers
 * alone don't, not to catch honeypots (the probe already does that better
 * than any model can, by actually executing the trade).
 *
 * No fabricated fallback: with no API key set this returns null and every
 * caller treats null as "AI unavailable," never as "AI approved."
 */

export interface TokenProfile {
  symbol: string;
  token: string;
  liqPls: number;
  buyTaxBps: number;
  sellTaxBps: number;
  lpLockedPct: number;
  deployerPct: number | null; // null when unknown - e.g. Discovery/Hunter finds with no deployer on file
  ownerRenounced: boolean;
  roundTripLossBps: number;
  priceMovePct: number | null;
  liqGrowthPct: number | null;
  rsi: number | null;
  macdHistogram: number | null;
  macdBullishCross: boolean | null;
  bollingerPercentB: number | null;
  atrPct: number | null;   // ATR(14) as a % of price - how much this token normally moves
  volRatio: number | null; // recent candle volume vs. this token's own baseline; >1 means hotter than usual
  narrative?: string; // e.g. discovery.ts's buildNarrative, if this came from there
}

export interface AiVerdict {
  recommend: boolean;
  confidence: "low" | "medium" | "high";
  reasoning: string;
  /** Only meaningful when assess() was called with a maxAmountPls - how
   * much of that authorized ceiling the model actually wants to spend.
   * Never exceeds maxAmountPls (clamped defensively even if the model
   * ignores the instruction); undefined when assess() had no ceiling to
   * size against. */
  suggestedAmountPls?: number;
}

function describeProfile(p: TokenProfile): string {
  const lines = [
    `Token: ${p.symbol} (${p.token})`,
    `Liquidity: ${Math.round(p.liqPls).toLocaleString()} PLS`,
    `Buy tax: ${(p.buyTaxBps / 100).toFixed(1)}%, sell tax: ${(p.sellTaxBps / 100).toFixed(1)}%`,
    `Round trip buy+sell loses ${p.roundTripLossBps} bps beyond tax (slippage/other friction)`,
    `LP locked or burned: ${p.lpLockedPct.toFixed(1)}%`,
    `Deployer holds: ${p.deployerPct === null ? "unknown (not seen at pair creation)" : `${p.deployerPct.toFixed(1)}% of supply`}`,
    `Owner renounced: ${p.ownerRenounced ? "yes" : "no - owner retains privileged control"}`,
  ];
  if (p.priceMovePct !== null) lines.push(`Price moved ${p.priceMovePct.toFixed(0)}% in the last hour`);
  if (p.liqGrowthPct !== null) lines.push(`Liquidity grew ${p.liqGrowthPct.toFixed(0)}% in the last hour`);
  if (p.rsi !== null) lines.push(`RSI(14): ${p.rsi.toFixed(0)} ${p.rsi < 30 ? "(oversold)" : p.rsi > 70 ? "(overbought)" : ""}`);
  if (p.macdHistogram !== null)
    lines.push(`MACD histogram: ${p.macdHistogram.toFixed(4)}${p.macdBullishCross ? " (bullish cross just occurred)" : ""}`);
  if (p.bollingerPercentB !== null) lines.push(`Bollinger %B: ${p.bollingerPercentB.toFixed(2)} (0 = lower band, 1 = upper band)`);
  if (p.atrPct != null) lines.push(`ATR(14): ${p.atrPct.toFixed(1)}% of price (how much this token normally moves)`);
  if (p.volRatio != null && Number.isFinite(p.volRatio))
    lines.push(`Recent volume vs. this token's own baseline: ${p.volRatio.toFixed(1)}x`);
  if (p.narrative) lines.push(`Detector narrative: ${p.narrative}`);
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "You assess PulseChain (PulseX) tokens for a trading bot's users. Every token you see has " +
  "already passed a mechanical honeypot/sellability simulation, a tax check, and an LP-lock " +
  "check - those are hard gates, not your job to re-derive. Your job is judgment the numbers " +
  "alone miss: does the overall pattern look like real organic interest, or does it look " +
  "engineered/suspicious despite clearing the mechanical checks? You are not certain of " +
  "anything - a token can turn hostile in the next block, ownership renouncement and LP locks " +
  "can be faked or worked around by a sufficiently motivated attacker, and past price action " +
  "predicts nothing. Say so plainly when relevant. Never claim a trade is safe, only that it " +
  "looks reasonable or does not, and why.";

function verdictTool(maxAmountPls?: number) {
  const properties: Record<string, unknown> = {
    recommend: { type: "boolean", description: "Would you buy this, given only what's described?" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasoning: { type: "string", description: "2-4 sentences, plain English, cite specific numbers from the profile." },
  };
  const required = ["recommend", "confidence", "reasoning"];
  if (maxAmountPls !== undefined) {
    properties.suggestedAmountPls = {
      type: "number",
      description:
        `If recommending a buy, how much PLS to actually spend, out of an authorized maximum of ` +
        `${maxAmountPls} PLS. You do not have to use the full amount - spend less than the maximum ` +
        `when your confidence is lower, or when the opportunity itself looks smaller than the ceiling ` +
        `warrants. Never exceed ${maxAmountPls}. If not recommending a buy, omit this field.`,
    };
  }
  return {
    name: "give_verdict",
    description: "Report your trading assessment of this token.",
    input_schema: { type: "object", properties, required },
  };
}

async function callClaude(
  system: string, userContent: string, tool: { name: string } | null,
): Promise<any | null> {
  if (!CFG.anthropicApiKey) {
    log("warn", "ai", "ANTHROPIC_API_KEY not set - AI assessment skipped, treated as unavailable, never as approval");
    return null;
  }
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": CFG.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CFG.anthropicModel,
        max_tokens: 512,
        system,
        messages: [{ role: "user", content: userContent }],
        ...(tool ? { tools: [tool], tool_choice: { type: "tool", name: tool.name } } : {}),
      }),
    });
    if (!res.ok) {
      log("warn", "ai", `Claude API returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("warn", "ai", `Claude API call failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Forced structured verdict - used before an auto-buy. Null means the AI
 * gate is unavailable (no key, or the call failed), never "approved."
 *
 * `maxAmountPls`, when given, hands the model a spending ceiling and asks it
 * to size the trade itself - full authority up to that number, not a fixed
 * amount every time. A recommendation with no maxAmountPls (or one the
 * model didn't size) still requires the caller to fall back to its own
 * default sizing; this never fabricates a number the model didn't provide.
 *
 * `guidance`, when given, is this specific vault's own Hunter IQ lessons -
 * owner-typed feedback and the bot's own past reflections (see hunter.ts's
 * personalizedAssess) - oldest first, most recent last. Omitted entirely
 * for a vault with no lessons yet, which is what lets those vaults keep
 * sharing one AI call per opportunity across every subscriber instead of
 * paying for a personalized call each - see hunter.ts's dispatch().
 */
export async function assess(profile: TokenProfile, maxAmountPls?: number, guidance?: string[]): Promise<AiVerdict | null> {
  const ceilingLine = maxAmountPls !== undefined
    ? `\n\nYou are authorized to spend up to ${maxAmountPls} PLS on this - size the trade yourself, spending less than the maximum if your confidence is lower.`
    : "";
  const guidanceLine = guidance && guidance.length > 0
    ? `\n\nThis vault's owner has been coaching this bot based on past trades - the bot's own reflections are included too. ` +
      `Weigh this alongside the profile below, oldest first:\n${guidance.map((g, i) => `${i + 1}. ${g}`).join("\n")}`
    : "";
  const data = await callClaude(
    SYSTEM_PROMPT,
    `${describeProfile(profile)}${guidanceLine}\n\nWould you buy this token?${ceilingLine} Report your verdict via give_verdict.`,
    verdictTool(maxAmountPls),
  );
  if (!data) return null;
  const toolUse = (data.content ?? []).find((b: any) => b.type === "tool_use" && b.name === "give_verdict");
  if (!toolUse) {
    log("warn", "ai", "Claude did not return a give_verdict tool call, treating as unavailable");
    return null;
  }
  const input = toolUse.input as Partial<AiVerdict>;
  if (typeof input.recommend !== "boolean" || !input.reasoning) return null;
  const out: AiVerdict = {
    recommend: input.recommend,
    confidence: input.confidence === "high" || input.confidence === "medium" ? input.confidence : "low",
    reasoning: input.reasoning,
  };
  if (maxAmountPls !== undefined && typeof input.suggestedAmountPls === "number" && input.suggestedAmountPls > 0)
    out.suggestedAmountPls = Math.min(input.suggestedAmountPls, maxAmountPls);
  return out;
}

export interface OpenPositionContext {
  symbol: string;
  token: string;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;      // current gain/loss vs. entry, e.g. 42 means +42%
  peakPnlPct: number;   // best gain/loss this position has ever seen
  minutesHeld: number;
  rsi: number | null;
  macdHistogram: number | null;
  macdBullishCross: boolean | null;
  macdBearishCross: boolean | null;
  bollingerPercentB: number | null;
  atrPct: number | null;
  volRatio: number | null;
}

export interface ExitVerdict {
  sell: boolean;
  reasoning: string;
}

const EXIT_TOOL = {
  name: "give_exit_verdict",
  description: "Decide whether to sell this open position right now, or keep holding it.",
  input_schema: {
    type: "object",
    properties: {
      sell: { type: "boolean", description: "true to sell now, false to keep holding." },
      reasoning: { type: "string", description: "1-3 sentences, plain English, cite specific numbers." },
    },
    required: ["sell", "reasoning"],
  },
};

function describePosition(p: OpenPositionContext): string {
  const lines = [
    `Token: ${p.symbol} (${p.token})`,
    `Entry price: ${p.entryPrice}, current price: ${p.currentPrice}`,
    `Current P&L: ${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%`,
    `Best P&L this position has ever reached: ${p.peakPnlPct >= 0 ? "+" : ""}${p.peakPnlPct.toFixed(1)}%`,
    `Held for: ${Math.round(p.minutesHeld)} minutes`,
  ];
  if (p.rsi !== null) lines.push(`RSI(14): ${p.rsi.toFixed(0)} ${p.rsi < 30 ? "(oversold)" : p.rsi > 70 ? "(overbought)" : ""}`);
  if (p.macdHistogram !== null) {
    const cross = p.macdBullishCross ? " (bullish cross just occurred)" : p.macdBearishCross ? " (bearish cross just occurred)" : "";
    lines.push(`MACD histogram: ${p.macdHistogram.toFixed(4)}${cross}`);
  }
  if (p.bollingerPercentB !== null) lines.push(`Bollinger %B: ${p.bollingerPercentB.toFixed(2)} (0 = lower band, 1 = upper band)`);
  if (p.atrPct != null) lines.push(`ATR(14): ${p.atrPct.toFixed(1)}% of price`);
  if (p.volRatio != null && Number.isFinite(p.volRatio)) lines.push(`Recent volume vs. baseline: ${p.volRatio.toFixed(1)}x`);
  return lines.join("\n");
}

const EXIT_SYSTEM_PROMPT =
  "You help decide whether to hold or sell an ALREADY-OPEN position in a PulseChain (PulseX) " +
  "token, bought earlier by a trading bot on a technical dip-buying signal. A hard stop-loss " +
  "protects the downside no matter what you decide - your job is purely about the upside: is " +
  "there a real reason to think this still has room to run, or does the pattern suggest this is " +
  "a good place to take the win (or cut a genuinely fading position) rather than give gains back? " +
  "You have no special insight into the future - momentum can reverse in the next block, and a " +
  "token that ran 50% can just as easily run 100% more or crash back to zero. When genuinely " +
  "uncertain, there is nothing wrong with taking a solid profit rather than holding out for more - " +
  "but 'uncertain' means the setup has actually had time to show you something, not that you were " +
  "just asked. You will be asked about this same position again soon, every time it's still open - " +
  "a young position sitting close to its entry price is not fading, it is normal short-term noise " +
  "that hasn't resolved yet, and is not itself a reason to sell; weigh minutesHeld before reading " +
  "meaning into a small move. A small loss by itself - a percent or two - is not evidence the setup " +
  "failed; only treat this as a real reason to cut it if there's a genuine technical breakdown behind " +
  "it (RSI/MACD/Bollinger clearly turning against the position, not just sitting near neutral) or the " +
  "loss is closing in on the stop-loss, not because the position happens to be slightly red at the " +
  "moment you were asked. " +
  "Closing at a loss is a bad outcome, not a neutral one - it is money that is actually gone, not just " +
  "a number on a screen, and it should be treated as something to avoid, not something you're indifferent " +
  "to. There is no such symmetry on the other side: taking a genuine, well-earned profit is always fine, " +
  "but recommending a sell while the position is currently at a net loss should be rare and should " +
  "require you to name specific evidence (which indicator, what it's doing, how that differs from normal " +
  "noise) - 'this doesn't look great' is not enough to lock in a loss the position might otherwise " +
  "recover from. When genuinely torn on a position that's currently red, the default is hold, not sell - " +
  "the stop-loss already exists as the backstop for a real breakdown; you do not need to pre-empt it on " +
  "a hunch. " +
  "Be concrete: cite the specific numbers you're weighing, including how long this has actually been held.";

/**
 * Periodic re-judgment of an open position - used only by Hunter Bot's
 * "Auto Full" exit mode (see registry.ts's HunterConfig.exitMode). Unlike
 * assess(), a sell verdict here does not require a matching mechanical
 * check the way a buy does; the mechanical safety net for an open position
 * is the mandatory stop-loss that Auto Full still enforces regardless of
 * what this returns (see hunter.ts). Null means unavailable - callers must
 * treat that as "keep holding," never as a sell signal.
 */
export async function assessExit(position: OpenPositionContext): Promise<ExitVerdict | null> {
  const data = await callClaude(
    EXIT_SYSTEM_PROMPT,
    `${describePosition(position)}\n\nHold or sell? Report your verdict via give_exit_verdict.`,
    EXIT_TOOL,
  );
  if (!data) return null;
  const toolUse = (data.content ?? []).find((b: any) => b.type === "tool_use" && b.name === "give_exit_verdict");
  if (!toolUse) {
    log("warn", "ai", "Claude did not return a give_exit_verdict tool call, treating as unavailable");
    return null;
  }
  const input = toolUse.input as Partial<ExitVerdict>;
  if (typeof input.sell !== "boolean" || !input.reasoning) return null;
  return { sell: input.sell, reasoning: input.reasoning };
}

const LESSON_TOOL = {
  name: "give_lesson",
  description: "Write one short, concrete, forward-looking lesson from this trade.",
  input_schema: {
    type: "object",
    properties: {
      lesson: {
        type: "string",
        description:
          "1-2 sentences, plain English, addressed to yourself for next time - what would you " +
          "actually do differently, not just a restatement of what happened. Cite the specific " +
          "number that mattered.",
      },
    },
    required: ["lesson"],
  },
};

async function callForLesson(system: string, userContent: string): Promise<string | null> {
  const data = await callClaude(system, userContent, LESSON_TOOL);
  if (!data) return null;
  const toolUse = (data.content ?? []).find((b: any) => b.type === "tool_use" && b.name === "give_lesson");
  const lesson = toolUse?.input?.lesson;
  return typeof lesson === "string" && lesson.trim() ? lesson.trim() : null;
}

const LESSON_SYSTEM_PROMPT =
  "You are the trading logic behind a PulseChain (PulseX) dip-buying bot, writing a short note " +
  "to your future self about one of your own past trades. Be honest and specific, not defensive - " +
  "the point is to actually get better, not to justify what happened. A loss is not always a " +
  "mistake (some good setups just don't work out) and a miss is not always wrong to have passed on " +
  "- say so when that's genuinely the case, rather than inventing a lesson that isn't really there.";

/**
 * Self-reflection on a Hunter position that closed at a real loss - see
 * hunter.ts's reflectOnClosedLosses. Not every losing close is worth a
 * lesson (some are just how dip-buying goes); the caller only calls this
 * for closes past its own loss threshold, and this can still say "nothing
 * to learn here" in its own words rather than forcing a lesson that isn't
 * there - callers treat any non-null string as worth recording either way,
 * since even "this was just bad luck, the setup was sound" is a real,
 * useful data point for future personalized assessments.
 */
export async function reflectOnLoss(input: {
  symbol: string; token: string; buyNarrative: string; closeReason: string; pnlPct: number; heldMinutes: number;
}): Promise<string | null> {
  const content =
    `You bought ${input.symbol} (${input.token}). At the time: ${input.buyNarrative}\n\n` +
    `It closed ${input.heldMinutes < 60 ? `${Math.round(input.heldMinutes)} minutes` : `${(input.heldMinutes / 60).toFixed(1)} hours`} later at ${input.pnlPct.toFixed(1)}%, reason: ${input.closeReason}.\n\n` +
    `Write yourself a lesson from this via give_lesson.`;
  return callForLesson(LESSON_SYSTEM_PROMPT, content);
}

/**
 * Self-reflection on a Hunter opportunity that passed the mechanical screen
 * but got declined (by the AI gate, or by an owner who never acted on a
 * notify) - see hunter.ts's reflectOnMissedOpportunities. Only called for
 * ones that moved meaningfully since being declined, so this is always
 * looking at a real "would have worked" case, not noise.
 */
export async function reflectOnMiss(input: {
  symbol: string; token: string; detectionNarrative: string; declineReason: string; movePctSinceDeclined: number; daysSinceDeclined: number;
}): Promise<string | null> {
  const content =
    `You saw ${input.symbol} (${input.token}) and passed on it. At the time: ${input.detectionNarrative}\n\n` +
    `The decision was: ${input.declineReason}\n\n` +
    `${input.daysSinceDeclined.toFixed(1)} days later, it's up ${input.movePctSinceDeclined.toFixed(0)}% from where it was when you saw it - you missed this one.\n\n` +
    `Write yourself a lesson from this via give_lesson.`;
  return callForLesson(LESSON_SYSTEM_PROMPT, content);
}

/** Free-form answer for Ask Icaria - the user's own question, in their own
 * words, alongside the token's profile. Null means unavailable. */
export async function answerQuestion(profile: TokenProfile, question: string): Promise<string | null> {
  const data = await callClaude(
    SYSTEM_PROMPT,
    `${describeProfile(profile)}\n\nThe user asks: "${question}"\n\nAnswer directly and plainly, in a few sentences.`,
    null,
  );
  if (!data) return null;
  const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
  return textBlock?.text ?? null;
}
