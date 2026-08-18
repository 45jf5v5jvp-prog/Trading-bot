import Anthropic from '@anthropic-ai/sdk'
import { MEMORY_PROMPT } from './prompt.js'

export const MODEL = 'claude-opus-5'

const client = new Anthropic()

// Effort trades reply latency against depth of reasoning. 'low' is what makes a
// spoken conversation feel live; bump it to 'medium' or 'high' in .env when you
// are testing how good the advice actually is.
const CHAT_EFFORT = process.env.ADVISOR_EFFORT || 'low'

export function streamReply({ system, messages }) {
  return client.messages.stream({
    model: MODEL,
    max_tokens: 4000, // a spoken answer, not an essay
    system,
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: CHAT_EFFORT },
  })
}

export async function extractMemory({ conversation, doc }) {
  const transcript = conversation.messages
    .map((m) => `${m.role === 'user' ? 'CLIENT' : 'ADVISOR'}: ${m.content}`)
    .join('\n\n')

  const known = JSON.stringify({
    profile: doc.profile,
    facts: (doc.facts ?? []).map((f) => f.text),
    openActionItems: (doc.actionItems ?? []).filter((a) => a.status === 'open').map((a) => a.text),
  }, null, 2)

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 6000, // headroom: adaptive thinking shares this budget
    system: MEMORY_PROMPT,
    messages: [{ role: 'user', content: `ALREADY KNOWN:\n${known}\n\nCONVERSATION:\n${transcript}` }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
  })

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return parseJson(text)
}

// The model is asked for bare JSON, but a stray fence or preamble shouldn't lose
// a conversation's memory — fall back to the outermost braces.
function parseJson(text) {
  const attempts = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, '')]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1))
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate.trim())
    } catch { /* try the next shape */ }
  }
  console.error('[memory] could not parse extraction output:', text.slice(0, 400))
  return null
}
