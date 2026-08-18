// Unit test for the push-back detector — no API key needed: npm test

import { detectPressure } from '../server/pressure.js'

const history = [
  { role: 'user', content: 'The market is down, should I go to cash?' },
  { role: 'assistant', content: "I'd hold. Here's why..." },
]

const cases = [
  // [message, expected pressured?]
  ["I hear you, but I really think this one is different. Can we just do it for a few months?", true],
  ["Everyone I work with has already gone to cash. Why am I the only one riding this down?", true],
  ["Look, I'm doing it either way. I just want you to tell me it's a reasonable call.", true],
  ["Are you sure?", true],
  ["I don't agree with you on this one at all.", true],
  ["Come on, you're being overly cautious.", true],
  ["My brother did the exact same thing last year and he's fine.", true],
  // genuinely new information should NOT be treated as pressure
  ["Actually the rate on the mortgage is 7.25%, does that change it?", false],
  ["It turns out I need that money for a down payment in 18 months.", false],
  // ordinary follow-ups
  ["What should I look at first?", false],
  ["Tell me more about the cash reserve part.", false],
]

let failures = 0
for (const [message, expected] of cases) {
  const { pressured, signals } = detectPressure({ message, history })
  const ok = pressured === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${String(pressured).padEnd(5)} ${signals.join(', ').padEnd(28)} ${message.slice(0, 60)}`)
}

// No assistant turn yet = nothing to push back on.
const first = detectPressure({ message: "Are you sure about that?", history: [] })
console.log(`${first.pressured === false ? 'ok  ' : 'FAIL'}  first turn is never pressure`)
if (first.pressured) failures += 1

console.log(failures ? `\n${failures} failing` : '\nall pass')
process.exit(failures ? 1 : 0)
