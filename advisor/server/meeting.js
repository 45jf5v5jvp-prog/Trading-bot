// Meeting shape.
//
// A meeting has a running order (persona/meeting-flow.md) and a length the client
// agreed to. Neither the order nor the clock can live in a prompt alone, so the
// agenda and the checkpoints are tracked here and pushed back into the
// conversation as operator notes at the moment they matter.

export const DEFAULT_MINUTES = 30
export const MEETING_LENGTHS = [15, 30, 45, 60, 90]

export function elapsedMinutes(conversation) {
  const first = conversation.messages[0]
  if (!first) return 0
  return (Date.now() - new Date(first.ts ?? conversation.createdAt).getTime()) / 60000
}

export const plannedMinutes = (conversation) => conversation.plannedMinutes ?? DEFAULT_MINUTES

// Three moments, each firing once:
//   mid       — enough time gone that the shape of the meeting is set
//   wrap      — five minutes left, time to land it
//   overtime  — past what they agreed to; they get to decide, not the advisor
export function dueCheckpoint(conversation) {
  const planned = plannedMinutes(conversation)
  const elapsed = elapsedMinutes(conversation)
  const fired = conversation.checkpoints ?? {}

  if (elapsed >= planned && !fired.overtime) return 'overtime'
  if (planned > 15 && elapsed >= planned - 5 && !fired.wrap) return 'wrap'
  if (elapsed >= Math.max(10, planned * 0.6) && !fired.mid) return 'mid'
  return null
}

export function buildTimeNote(kind, conversation, agenda = []) {
  const planned = plannedMinutes(conversation)
  const elapsed = Math.round(elapsedMinutes(conversation))
  const remaining = Math.max(0, planned - elapsed)

  const covered = agenda.filter((item) => item.covered).map((item) => item.text)
  const left = agenda.filter((item) => !item.covered).map((item) => item.text)
  const listState = [
    covered.length ? `Covered so far: ${covered.join('; ')}.` : 'Nothing marked covered yet.',
    left.length ? `Still on their list: ${left.join('; ')}.` : 'Their list is covered.',
  ].join(' ')

  const body = {
    mid: `You are ${elapsed} minutes into a ${planned} minute meeting, so about ${remaining} left.

Check in on time the way you always do — ask whether they're still okay on time or whether it's
better to put another block on the calendar. Ask it plainly and let them answer; don't apologize
for the length and don't rush to reassure them.

${listState} If time is tight, say which item you'd want to protect and which can wait.`,

    wrap: `About five minutes left of the ${planned} minutes they booked.

Start landing it. Don't open a new topic. ${left.length
  ? `These are still on their list: ${left.join('; ')}. Say plainly what you can cover now and what should get its own time.`
  : "Their list is covered — use the time to confirm what they are walking away with."}

Ask whether they want to keep going past ${planned} minutes or stop here and book the rest.`,

    overtime: `You are at ${elapsed} minutes against the ${planned} they booked.

Stop and hand them the decision: keep going, or stop here and put the rest on the calendar. Do not
assume they want to continue because the conversation is good — they may have something after this.
${left.length ? `Still on their list: ${left.join('; ')}.` : ''}`,
  }[kind]

  return `[Operator note, not from the client.\n\n${body}]`
}

// The agenda they set at the top is a promise. It gets rendered into the dossier
// every turn so it can't quietly slide off the table.
export function renderAgenda(agenda = []) {
  if (!agenda.length) return ''
  const lines = agenda.map((item) => `- [${item.covered ? 'covered' : 'not yet'}] ${item.text}`)
  return `What they said was important to them today — you told them you'd get to all of it:\n${
    lines.join('\n')}`
}

export function renderAdvisorExperience(experience) {
  if (!experience) return ''
  const parts = [`Prior advisor experience: ${experience.status}`]
  if (experience.grade) parts.push(`They graded their current advisor a ${experience.grade}`)
  if (experience.whatWouldMakeItAnA) {
    parts.push(`What would make it an A: ${experience.whatWouldMakeItAnA}`)
  }
  return `${parts.join('. ')}.\nThat gap is the brief. It is the most useful thing they will tell you today.`
}

export function renderClock(conversation) {
  if (!conversation) return ''
  const planned = plannedMinutes(conversation)
  const elapsed = Math.round(elapsedMinutes(conversation))
  return `Clock: ${elapsed} of ${planned} minutes they booked for today.`
}
