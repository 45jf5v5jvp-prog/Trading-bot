import React, { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const FIELDS = [
  ['name', 'Name'],
  ['age', 'Age'],
  ['household', 'Household'],
  ['occupation', 'Work'],
  ['income', 'Income'],
  ['savings', 'Invested assets'],
  ['debts', 'Debts'],
  ['goals', 'Goals'],
  ['riskTolerance', 'Risk tolerance'],
  ['retirementTarget', 'Retirement target'],
]

export default function Memory({ me, onOpenConversation, onRefresh }) {
  const [profile, setProfile] = useState({})
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState('memory')

  useEffect(() => { setProfile(me?.profile ?? {}); setDirty(false) }, [me?.profile])

  async function saveProfile() {
    await api.saveProfile(profile)
    setDirty(false)
    onRefresh()
  }

  async function toggleItem(item) {
    await api.setActionItem(item.id, item.status === 'open' ? 'done' : 'open')
    onRefresh()
  }

  if (!me) return <aside className="panel"><div className="muted">Loading…</div></aside>

  const openItems = me.actionItems.filter((a) => a.status === 'open')
  const doneItems = me.actionItems.filter((a) => a.status === 'done')

  return (
    <aside className="panel">
      <nav className="tabs">
        <button className={tab === 'memory' ? 'on' : ''} onClick={() => setTab('memory')}>Memory</button>
        <button className={tab === 'profile' ? 'on' : ''} onClick={() => setTab('profile')}>Profile</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
      </nav>

      {tab === 'memory' && (
        <div className="panel-body">
          <h3>What it remembers about you</h3>
          {me.facts.length ? (
            <ul className="facts">{me.facts.map((f) => <li key={f.id}>{f.text}</li>)}</ul>
          ) : (
            <p className="muted">Nothing yet. Have a conversation, then hit “End &amp; remember”.</p>
          )}

          <h3>Open items</h3>
          {openItems.length ? (
            <ul className="items">
              {openItems.map((item) => (
                <li key={item.id}>
                  <label>
                    <input type="checkbox" onChange={() => toggleItem(item)} />
                    {item.text}
                  </label>
                </li>
              ))}
            </ul>
          ) : <p className="muted">None open.</p>}

          {doneItems.length > 0 && (
            <details>
              <summary>{doneItems.length} done</summary>
              <ul className="items done">
                {doneItems.map((item) => (
                  <li key={item.id}>
                    <label>
                      <input type="checkbox" checked readOnly onClick={() => toggleItem(item)} />
                      {item.text}
                    </label>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {tab === 'profile' && (
        <div className="panel-body">
          <h3>The basics</h3>
          <p className="muted">
            Fill in what you like — the AI also picks these up from conversation.
          </p>
          {FIELDS.map(([key, label]) => (
            <label key={key} className="field">
              {label}
              <input
                value={profile[key] ?? ''}
                onChange={(e) => { setProfile({ ...profile, [key]: e.target.value }); setDirty(true) }}
              />
            </label>
          ))}
          <button className="primary wide" disabled={!dirty} onClick={saveProfile}>
            {dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      )}

      {tab === 'history' && (
        <div className="panel-body">
          <h3>Past reviews</h3>
          {me.conversations.length ? (
            <ul className="history">
              {[...me.conversations].reverse().map((c) => (
                <li key={c.id}>
                  <button className="link" onClick={() => onOpenConversation(c.id)}>
                    <strong>{c.title}</strong>
                    <span className="when">{new Date(c.createdAt).toLocaleDateString()}</span>
                  </button>
                  {c.summary && <p className="muted">{c.summary}</p>}
                </li>
              ))}
            </ul>
          ) : <p className="muted">No reviews yet.</p>}

          <div className="stat">
            <span>{me.persona.recordedAnswers}</span> recorded answers ·{' '}
            <span>{Math.round(me.persona.styleGuideChars / 1000)}k</span> style guide · {me.model}
          </div>
        </div>
      )}
    </aside>
  )
}
