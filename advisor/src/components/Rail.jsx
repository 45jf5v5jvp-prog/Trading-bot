import React, { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { BUCKET_COLORS, BUCKET_LABELS } from './ToolCard.jsx'

const PROFILE_FIELDS = [
  ['name', 'Name'],
  ['age', 'Age'],
  ['household', 'Household'],
  ['occupation', 'Work'],
  ['retirementTarget', 'Retirement target'],
  ['monthlySpending', 'Monthly spending'],
]

const money = (n) => `$${Math.round(n || 0).toLocaleString('en-US')}`

export default function Rail({ me, onOpenConversation, onRefresh }) {
  const [tab, setTab] = useState('meeting')

  if (!me) return <aside className="panel"><div className="panel-body muted">Loading…</div></aside>

  const tabs = [
    ['meeting', 'Meeting'],
    ['money', 'Money'],
    ['memory', 'Memory'],
    ['history', 'History'],
  ]

  return (
    <aside className="panel">
      <nav className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      <div className="panel-body">
        {tab === 'meeting' && <Meeting me={me} onRefresh={onRefresh} />}
        {tab === 'money' && <Money me={me} onRefresh={onRefresh} />}
        {tab === 'memory' && <Remembered me={me} onRefresh={onRefresh} />}
        {tab === 'history' && <History me={me} onOpen={onOpenConversation} />}
      </div>
    </aside>
  )
}

// What they said mattered today, and what they've had before.
function Meeting({ me, onRefresh }) {
  const agenda = me.agenda ?? []
  const experience = me.advisorExperience

  async function toggle(index, covered) {
    await api.setAgendaCovered(index, covered)
    onRefresh()
  }

  return (
    <>
      <h3>What matters today</h3>
      {agenda.length ? (
        <ul className="items">
          {agenda.map((item, i) => (
            <li key={i} className={item.covered ? 'done' : ''}>
              <label>
                <input type="checkbox" checked={item.covered} onChange={(e) => toggle(i, e.target.checked)} />
                {item.text}
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          Nothing yet. It fills in when you answer “what do you want to make sure we talk about.”
        </p>
      )}

      <h3>Advisor history</h3>
      {experience ? (
        <div className="grade-block">
          <div className="grade">
            <b>{experience.grade || '—'}</b>
            <span>{
              {
                has_advisor: 'has an advisor',
                self_directed: 'does it themselves',
                between_advisors: 'between advisors',
                never_had_one: 'never had one',
              }[experience.status] ?? experience.status
            }</span>
          </div>
          {experience.whatWouldMakeItAnA && (
            <p className="brief">
              <span>What would make it an A</span>
              {experience.whatWouldMakeItAnA}
            </p>
          )}
        </div>
      ) : <p className="muted">Not asked yet.</p>}
    </>
  )
}

// Everything in one place, and what the projection made of it.
function Money({ me, onRefresh }) {
  const [rows, setRows] = useState(me.accounts ?? [])
  const [dirty, setDirty] = useState(false)

  useEffect(() => { setRows(me.accounts ?? []); setDirty(false) }, [me.accounts])

  const total = rows.reduce((t, r) => t + (Number(r.balance) || 0), 0)
  const byBucket = {}
  for (const row of rows) {
    byBucket[row.bucket] = (byBucket[row.bucket] ?? 0) + (Number(row.balance) || 0)
  }
  const mix = Object.keys(BUCKET_COLORS)
    .filter((key) => byBucket[key] > 0)
    .map((key) => ({ key, percent: (byBucket[key] / total) * 100, value: byBucket[key] }))

  const edit = (i, field, value) => {
    const next = [...rows]
    next[i] = { ...next[i], [field]: field === 'label' || field === 'bucket' ? value : Number(value) }
    setRows(next)
    setDirty(true)
  }
  const addRow = () => {
    setRows([...rows, { label: '', bucket: 'pretax', balance: 0, annualContribution: 0 }])
    setDirty(true)
  }
  const removeRow = (i) => { setRows(rows.filter((_, j) => j !== i)); setDirty(true) }

  async function save() {
    await api.saveAccounts(rows.filter((r) => r.label.trim()))
    setDirty(false)
    onRefresh()
  }

  return (
    <>
      <h3>Everything in one place</h3>
      {total > 0 && (
        <>
          <div className="hero small"><b>{money(total)}</b><span>across {mix.length} tax bucket{mix.length === 1 ? '' : 's'}</span></div>
          <div className="mix" role="img" aria-label={mix.map((m) => `${BUCKET_LABELS[m.key]} ${Math.round(m.percent)}%`).join(', ')}>
            {mix.map((m) => (
              <div key={m.key} className="seg" style={{ width: `${m.percent}%`, background: BUCKET_COLORS[m.key] }}>
                {m.percent >= 14 && <span>{Math.round(m.percent)}%</span>}
              </div>
            ))}
          </div>
          <ul className="legend">
            {mix.map((m) => (
              <li key={m.key}><i style={{ background: BUCKET_COLORS[m.key] }} />{BUCKET_LABELS[m.key]} <b>{money(m.value)}</b></li>
            ))}
          </ul>
        </>
      )}

      <div className="accounts">
        {rows.map((row, i) => (
          <div className="account" key={i}>
            <input
              value={row.label}
              placeholder="Account name"
              onChange={(e) => edit(i, 'label', e.target.value)}
            />
            <div className="account-row">
              <select value={row.bucket} onChange={(e) => edit(i, 'bucket', e.target.value)}>
                {Object.entries(BUCKET_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <input
                type="number"
                value={row.balance ?? 0}
                onChange={(e) => edit(i, 'balance', e.target.value)}
                aria-label="Balance"
              />
              <button className="remove" onClick={() => removeRow(i)} aria-label="Remove account">×</button>
            </div>
          </div>
        ))}
        <button className="ghost wide" onClick={addRow}>Add an account</button>
        {dirty && <button className="primary wide" onClick={save}>Save accounts</button>}
      </div>

      {me.lastProjection && (
        <>
          <h3>Last projection</h3>
          <p className="muted">
            {money(me.lastProjection.atRetirement.total)} at {me.lastProjection.atRetirement.age}
            {me.lastProjection.outcome.lastsToLifeExpectancy
              ? ' — lasts to life expectancy.'
              : ` — runs out at ${me.lastProjection.outcome.moneyRunsOutAtAge}.`}
          </p>
        </>
      )}

      {me.documents?.length > 0 && (
        <>
          <h3>Drafts</h3>
          <ul className="facts">
            {me.documents.map((d, i) => <li key={i}>{d.title} <span className="muted">· attorney review required</span></li>)}
          </ul>
        </>
      )}
    </>
  )
}

function Remembered({ me, onRefresh }) {
  const [profile, setProfile] = useState(me.profile ?? {})
  const [dirty, setDirty] = useState(false)
  useEffect(() => { setProfile(me.profile ?? {}); setDirty(false) }, [me.profile])

  const open = me.actionItems.filter((a) => a.status === 'open')

  async function toggleItem(item) {
    await api.setActionItem(item.id, item.status === 'open' ? 'done' : 'open')
    onRefresh()
  }
  async function save() {
    await api.saveProfile(profile)
    setDirty(false)
    onRefresh()
  }

  return (
    <>
      <h3>What it remembers</h3>
      {me.facts.length
        ? <ul className="facts">{me.facts.map((f) => <li key={f.id}>{f.text}</li>)}</ul>
        : <p className="muted">Nothing yet. End a review and it writes this itself.</p>}

      <h3>Open items</h3>
      {open.length ? (
        <ul className="items">
          {open.map((item) => (
            <li key={item.id}>
              <label>
                <input type="checkbox" onChange={() => toggleItem(item)} />
                {item.text}
              </label>
            </li>
          ))}
        </ul>
      ) : <p className="muted">None open.</p>}

      <h3>The basics</h3>
      {PROFILE_FIELDS.map(([key, label]) => (
        <label key={key} className="field">
          {label}
          <input
            value={profile[key] ?? ''}
            onChange={(e) => { setProfile({ ...profile, [key]: e.target.value }); setDirty(true) }}
          />
        </label>
      ))}
      <button className="primary wide" disabled={!dirty} onClick={save}>{dirty ? 'Save' : 'Saved'}</button>
    </>
  )
}

function History({ me, onOpen }) {
  return (
    <>
      <h3>Past reviews</h3>
      {me.conversations.length ? (
        <ul className="history">
          {[...me.conversations].reverse().map((c) => (
            <li key={c.id}>
              <button className="link" onClick={() => onOpen(c.id)}>
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
        <span>{Math.round(me.persona.styleGuideChars / 1000)}k</span> style guide ·{' '}
        <span>{Math.round((me.persona.positionsChars ?? 0) / 1000)}k</span> positions · {me.model}
      </div>
    </>
  )
}
