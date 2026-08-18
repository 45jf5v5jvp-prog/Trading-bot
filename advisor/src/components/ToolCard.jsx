import React, { useState } from 'react'

// Fixed hue order — validated for both themes (OKLCH lightness band, chroma
// floor, CVD separation, contrast). Colour follows the bucket, never its size,
// so a client with three accounts and one with six read the same way.
export const BUCKET_COLORS = {
  pretax: '#2E8B5F',
  roth: '#C8801F',
  taxable: '#3E79C9',
  life: '#C4553F',
  cash: '#1F9AA0',
  hsa: '#9B5BA5',
}
export const BUCKET_LABELS = {
  pretax: 'Pre-tax',
  roth: 'Roth',
  taxable: 'Taxable',
  life: 'Cash value life',
  cash: 'Cash',
  hsa: 'HSA',
}
const ORDER = Object.keys(BUCKET_COLORS)

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`
const short = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}k`)

export default function ToolCard({ name, result }) {
  if (result?.error) {
    return <div className="tool-card bad"><b>Couldn't run that</b><p>{result.error}</p></div>
  }
  if (name === 'run_retirement_projection') return <Projection result={result} />
  if (name === 'draft_document') return <Document result={result} />
  return <Note name={name} result={result} />
}

function Note({ name, result }) {
  const text = {
    record_agenda: `Agenda recorded — ${result.saved} item${result.saved === 1 ? '' : 's'}`,
    record_advisor_experience: 'Advisor history recorded',
    save_accounts: result.accounts !== undefined
      ? `${result.accounts} accounts · ${money(result.total)} across ${result.bucketsHeld?.length ?? 0} tax buckets`
      : 'Accounts saved',
  }[name] ?? name
  return <div className="tool-note">{text}</div>
}

function Projection({ result }) {
  const [showTable, setShowTable] = useState(false)
  const { atRetirement, outcome, income, assumptions, whatIfs = [] } = result
  const mix = ORDER
    .filter((key) => atRetirement.mixPercent[key] > 0)
    .map((key) => ({ key, percent: atRetirement.mixPercent[key], value: atRetirement.balances[key] }))

  return (
    <div className="tool-card">
      <div className="card-head">
        <span className="kicker">Projection</span>
        <span className={`verdict ${outcome.lastsToLifeExpectancy ? 'good' : 'warn'}`}>
          {outcome.lastsToLifeExpectancy
            ? `Lasts past ${assumptions.lifeExpectancy}`
            : `Runs out at ${outcome.moneyRunsOutAtAge}`}
        </span>
      </div>

      <div className="hero">
        <b>{short(atRetirement.total)}</b>
        <span>
          at age {atRetirement.age}, across {atRetirement.bucketsHeld} tax bucket
          {atRetirement.bucketsHeld === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mix" role="img" aria-label={mix.map((m) => `${BUCKET_LABELS[m.key]} ${m.percent}%`).join(', ')}>
        {mix.map((m) => (
          <div key={m.key} className="seg" style={{ width: `${m.percent}%`, background: BUCKET_COLORS[m.key] }}>
            {m.percent >= 12 && <span>{m.percent}%</span>}
          </div>
        ))}
      </div>
      <ul className="legend">
        {mix.map((m) => (
          <li key={m.key}>
            <i style={{ background: BUCKET_COLORS[m.key] }} />
            {BUCKET_LABELS[m.key]} <b>{money(m.value)}</b>
          </li>
        ))}
      </ul>

      <dl className="figures">
        <div><dt>First-year withdrawal</dt><dd>{money(income.firstYearGrossWithdrawal)}</dd></div>
        <div><dt>Tax on it</dt><dd>{money(income.firstYearTax)} · {income.effectiveTaxRateFirstYear}%</dd></div>
        <div><dt>Forced RMDs, lifetime</dt><dd>{money(outcome.lifetimeRmdForced)}</dd></div>
        <div><dt>Tax paid, lifetime</dt><dd>{money(outcome.lifetimeTaxPaid)}</dd></div>
      </dl>

      {whatIfs.length > 0 && (
        <table className="whatifs">
          <caption>Stress tests</caption>
          <tbody>
            {whatIfs.map((w) => (
              <tr key={w.label}>
                <th scope="row">{w.label}</th>
                <td className={w.lastsToLifeExpectancy ? 'good' : 'warn'}>
                  {w.error ? w.error
                    : w.lastsToLifeExpectancy ? `holds · ends ${short(w.endingBalance)}`
                    : `runs out at ${w.moneyRunsOutAtAge}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button className="link" onClick={() => setShowTable((v) => !v)}>
        {showTable ? 'Hide' : 'Show'} the numbers and assumptions
      </button>
      {showTable && (
        <div className="assumptions">
          <table>
            <tbody>
              {mix.map((m) => (
                <tr key={m.key}>
                  <th scope="row">{BUCKET_LABELS[m.key]}</th>
                  <td>{money(m.value)}</td>
                  <td>{m.percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Returns {(assumptions.returnBefore * 100).toFixed(1)}% before retirement and{' '}
            {(assumptions.returnAfter * 100).toFixed(1)}% after, inflation{' '}
            {(assumptions.inflation * 100).toFixed(1)}%, ordinary rate{' '}
            {(assumptions.ordinaryTaxRate * 100).toFixed(0)}%, RMDs from {assumptions.rmdAge}.
          </p>
          <p className="caveat">{assumptions.note}</p>
        </div>
      )}
    </div>
  )
}

function Document({ result }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="tool-card">
      <div className="card-head">
        <span className="kicker">Draft</span>
        <span className="verdict warn">Attorney review required</span>
      </div>
      <div className="hero">
        <b className="doc-title">{result.title}</b>
        <span>{result.label}{result.state ? ` · ${result.state}` : ''}</span>
      </div>

      {result.gaps?.length > 0 && (
        <ul className="gaps">{result.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
      )}
      {result.placeholders?.length > 0 && (
        <p className="muted small">Left blank on purpose: {result.placeholders.join(', ')}</p>
      )}

      <h4>What your attorney needs to check</h4>
      <ul className="checklist">
        {result.attorneyChecklist.map((item, i) => <li key={i}>{item}</li>)}
      </ul>

      <button className="link" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Read'} the draft
      </button>
      {open && <pre className="doc">{result.document}</pre>}
    </div>
  )
}
