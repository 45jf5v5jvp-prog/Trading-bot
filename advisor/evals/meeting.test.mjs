// The clock and the agenda — the parts of a meeting a prompt can't hold on its own.
import {
  dueCheckpoint, buildTimeNote, renderAgenda, renderAdvisorExperience, renderClock,
  plannedMinutes, DEFAULT_MINUTES,
} from '../server/meeting.js'

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const ago = (n) => new Date(Date.now() - n * 60000).toISOString()
const meeting = (elapsed, planned = 30, checkpoints = {}) => ({
  createdAt: ago(elapsed),
  plannedMinutes: planned,
  checkpoints,
  messages: [{ role: 'user', content: 'hi', ts: ago(elapsed) }],
})

check('quiet early on', dueCheckpoint(meeting(5)) === null)
check('mid-meeting check at 60% of the booked time', dueCheckpoint(meeting(20)) === 'mid')
check('wrap warning five minutes out', dueCheckpoint(meeting(26, 30, { mid: ago(6) })) === 'wrap')
check('overtime once past the booking',
  dueCheckpoint(meeting(31, 30, { mid: ago(11), wrap: ago(5) })) === 'overtime')
check('each checkpoint fires once', dueCheckpoint(meeting(21, 30, { mid: ago(1) })) === null)
check('a short meeting skips the wrap warning',
  dueCheckpoint(meeting(12, 15, { mid: ago(2) })) === null,
  '15-minute meetings would otherwise warn before they started')
check('a meeting with no messages has no clock', dueCheckpoint({ createdAt: ago(60), messages: [] }) === null)
check('unset length falls back to the default', plannedMinutes({}) === DEFAULT_MINUTES)

const agenda = [
  { text: 'am I going to be okay', covered: true },
  { text: 'helping my daughter with a house', covered: false },
]

const mid = buildTimeNote('mid', meeting(20), agenda)
check('mid note offers another block', mid.includes('another block'))
check('mid note carries what is left', mid.includes('helping my daughter with a house'))

const wrap = buildTimeNote('wrap', meeting(26), agenda)
check('wrap note stops new topics', wrap.includes("Don't open a new topic"))
check('wrap note offers to keep going or book the rest', wrap.includes('keep going'))

const over = buildTimeNote('overtime', meeting(33), agenda)
check('overtime hands the client the decision', over.includes('hand them the decision'))
check('overtime does not assume they want to continue', over.includes('may have something after this'))

check('every note is marked as an operator note',
  [mid, wrap, over].every((n) => n.startsWith('[Operator note')))
check('an empty agenda still reads sensibly', buildTimeNote('mid', meeting(20), []).includes('Nothing marked covered'))

check('agenda renders their words with status', renderAgenda(agenda).includes('[not yet] helping my daughter'))
check('no agenda renders nothing', renderAgenda([]) === '')
check('the clock is stated in the dossier', renderClock(meeting(12, 45)).includes('12 of 45'))

const brief = renderAdvisorExperience({ status: 'has_advisor', grade: 'C', whatWouldMakeItAnA: 'calling me back' })
check('the grade gap is framed as the brief', brief.includes('brief') && brief.includes('calling me back'))
check('no experience renders nothing', renderAdvisorExperience(null) === '')

console.log(failures ? `\n${failures} failing` : '\nall pass')
process.exit(failures ? 1 : 0)
