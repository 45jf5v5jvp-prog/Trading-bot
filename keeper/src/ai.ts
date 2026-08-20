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

async function callClaude(userContent: string, tool: ReturnType<typeof verdictTool> | null): Promise<any | null> {
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
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        ...(tool ? { tools: [tool], tool_choice: { type: "tool", name: "give_verdict" } } : {}),
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
 */
export async function assess(profile: TokenProfile, maxAmountPls?: number): Promise<AiVerdict | null> {
  const ceilingLine = maxAmountPls !== undefined
    ? `\n\nYou are authorized to spend up to ${maxAmountPls} PLS on this - size the trade yourself, spending less than the maximum if your confidence is lower.`
    : "";
  const data = await callClaude(
    `${describeProfile(profile)}\n\nWould you buy this token?${ceilingLine} Report your verdict via give_verdict.`,
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

/** Free-form answer for Ask Icaria - the user's own question, in their own
 * words, alongside the token's profile. Null means unavailable. */
export async function answerQuestion(profile: TokenProfile, question: string): Promise<string | null> {
  const data = await callClaude(
    `${describeProfile(profile)}\n\nThe user asks: "${question}"\n\nAnswer directly and plainly, in a few sentences.`,
    null,
  );
  if (!data) return null;
  const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
  return textBlock?.text ?? null;
}
