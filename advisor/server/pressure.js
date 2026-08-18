// Detects when a client is leaning on an answer rather than adding to it.
//
// This is a cheap heuristic on purpose. It doesn't decide anything — it only
// decides whether to spend one extra paragraph of prompt reminding the model not
// to fold. False positives cost almost nothing; a missed one costs the thing the
// advisor is actually being paid for.

const PUSHBACK = [
  [/\b(but|still|even so|regardless|anyway|whatever)\b/i, 'contested'],
  [/\b(are you sure|you sure|come on|seriously|really\?)/i, 'challenged'],
  [/\bi (really |still )?(want|think|feel like|believe)\b/i, 'restated want'],
  [/\bi'?m (going to|gonna|doing it)\b/i, 'declared intent'],
  [/\b(everyone|everybody|my (friend|buddy|coworker|brother|sister|dad|mom)|people)\b.{0,40}\b(says?|said|thinks?|thought|did|does|doing|has|have|already)\b/i, 'appeal to others'],
  [/\b(the only one|why am i the only)\b/i, 'odd one out'],
  [/\b(what if i just|why not|why can'?t i|can'?t i just)\b/i, 'seeking permission'],
  [/\b(i disagree|i don'?t agree|that'?s not right|you'?re wrong)\b/i, 'direct disagreement'],
]

// Words that suggest they answered a question rather than repeated themselves.
// A message carrying real numbers is usually new information, not pressure.
const NEW_INFORMATION = /\b(\d[\d,.]*\s*(k|%|percent|dollars|thousand|million)?|because|turns out|i found out|it'?s actually)\b/i

export function detectPressure({ message, history }) {
  // Nothing to push back on before the advisor has said something.
  if (!history.some((m) => m.role === 'assistant')) return { pressured: false, signals: [] }

  const signals = []
  for (const [pattern, label] of PUSHBACK) {
    if (pattern.test(message)) signals.push(label)
  }

  if (!signals.length) return { pressured: false, signals: [] }

  // Terseness sharpens a push but never makes one on its own — plenty of short
  // questions ("what should I look at first?") are just questions.
  const words = message.trim().split(/\s+/).length
  if (words <= 12 && /\?$/.test(message.trim())) signals.push('terse')

  // If they brought a number or a reason, treat it as an argument rather than
  // pressure — the model should be free to genuinely change its mind.
  if (NEW_INFORMATION.test(message) && signals.length < 2) {
    return { pressured: false, signals: [] }
  }

  return { pressured: true, signals }
}
