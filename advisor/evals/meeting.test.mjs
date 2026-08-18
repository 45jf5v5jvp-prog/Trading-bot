// The clock and the agenda — the two parts of a meeting a prompt can't hold on its own.
import { timeCheckDue, buildTimeCheckNote, renderAgenda, renderAdvisorExperience, TIME_CHECK_MINUTES } from '../server/meeting.js'

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString()
const conversation = (startedMinutesAgo, timeCheckedAt = null) => ({
  createdAt: minutesAgo(startedMinutesAgo),
  timeCheckedAt,
  messages: [{ role: 'user', content: 'hi', ts: minutesAgo(startedMinutesAgo) }],
})

check('no time check early in the meeting', !timeCheckDue(conversation(5)))
check(`time check comes due at ${TIME_CHECK_MINUTES} minutes`, timeCheckDue(conversation(21)))
check('it only fires once', !timeCheckDue(conversation(45, minutesAgo(20))))
check('a meeting with no messages is not overdue', !timeCheckDue({ createdAt: minutesAgo(60), messages: [] }))

const agenda = [
  { text: 'am I going to be okay', covered: true },
  { text: 'helping my daughter with a house', covered: false },
]
const note = buildTimeCheckNote(conversation(22), agenda)
check('the note names what is still on their list', note.includes('helping my daughter with a house'))
check('the note names what was covered', note.includes('am I going to be okay'))
check('the note is marked as an operator note', note.startsWith('[Operator note'))

const empty = buildTimeCheckNote(conversation(22), [])
check('an empty agenda still produces a usable note', empty.includes('what else surfaced'))

check('agenda renders their words, with status', renderAgenda(agenda).includes('[not yet] helping my daughter'))
check('no agenda renders nothing', renderAgenda([]) === '')

const brief = renderAdvisorExperience({ status: 'has_advisor', grade: 'C', whatWouldMakeItAnA: 'calling me back' })
check('the grade gap is framed as the brief', brief.includes('brief') && brief.includes('calling me back'))
check('no experience renders nothing', renderAdvisorExperience(null) === '')

console.log(failures ? `\n${failures} failing` : '\nall pass')
process.exit(failures ? 1 : 0)
