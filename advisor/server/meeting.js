// Meeting shape.
//
// A first meeting has a running order, and the advisor's version of it is in
// persona/meeting-flow.md. Two things about it can't live in a prompt alone: the
// clock, and the agenda the client set at the top. Both are tracked here and fed
// back into the conversation as operator notes at the moment they matter.

export const TIME_CHECK_MINUTES = 20

export function elapsedMinutes(conversation) {
  const first = conversation.messages[0]
  if (!first) return 0
  return (Date.now() - new Date(first.ts ?? conversation.createdAt).getTime()) / 60000
}

// Fires once, at the twenty minute mark. The advisor asks rather than assumes —
// a client who has to leave and doesn't get asked doesn't come back.
export function timeCheckDue(conversation) {
  return !conversation.timeCheckedAt && elapsedMinutes(conversation) >= TIME_CHECK_MINUTES
}

export function buildTimeCheckNote(conversation, agenda = []) {
  const covered = agenda.filter((item) => item.covered).map((item) => item.text)
  const remaining = agenda.filter((item) => !item.covered).map((item) => item.text)

  return `[Operator note, not from the client. You are ${Math.round(elapsedMinutes(conversation))} minutes in.

Before you go further, check in on time — the way you always do. Ask whether they're still okay on
time or whether it's better to put another block on the calendar. Ask it plainly and let them answer;
don't apologize for the length or rush to reassure them.

${covered.length ? `Covered so far: ${covered.join('; ')}.` : 'Nothing has been marked covered yet.'}
${remaining.length
  ? `Still on their list: ${remaining.join('; ')}. If time is short, say which of these you'd want to protect and which can wait.`
  : 'Their list is covered — this is a good moment to ask what else surfaced while you were talking.'}]`
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
