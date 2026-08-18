import React, { useState } from 'react'

// What they walk away with. Advisor actions and client homework stay strictly
// separate — who owes what is the part people misremember a week later.
export default function Recap({ recap, summary, title }) {
  const [copied, setCopied] = useState(false)
  if (!recap) return null

  const text = asText({ recap, summary, title })

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="tool-card recap">
      <div className="card-head">
        <span className="kicker">Recap</span>
        <span className="muted small">{recap.minutes} minutes</span>
      </div>
      <p className="recap-summary">{summary}</p>

      {recap.highlights?.length > 0 && (
        <>
          <h4>What we covered</h4>
          <ul className="checklist">{recap.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
        </>
      )}

      <div className="two-up">
        <div>
          <h4>What I'm doing</h4>
          {recap.advisorActions?.length
            ? <ul className="checklist">{recap.advisorActions.map((a, i) => <li key={i}>{a}</li>)}</ul>
            : <p className="muted small">Nothing on me this time.</p>}
        </div>
        <div>
          <h4>What you're doing</h4>
          {recap.clientHomework?.length
            ? <ul className="checklist homework">{recap.clientHomework.map((h, i) => <li key={i}>{h}</li>)}</ul>
            : <p className="muted small">Nothing on you this time.</p>}
        </div>
      </div>

      <button className="link" onClick={copy}>{copied ? 'Copied' : 'Copy this recap'}</button>
    </div>
  )
}

function asText({ recap, summary, title }) {
  const block = (heading, items) =>
    items?.length ? `\n${heading}\n${items.map((i) => `- ${i}`).join('\n')}\n` : ''
  return [
    title ? `${title}\n${'='.repeat(title.length)}\n` : '',
    summary,
    block('What we covered', recap.highlights),
    block("What I'm doing", recap.advisorActions),
    block("What you're doing", recap.clientHomework),
  ].join('\n').trim()
}
