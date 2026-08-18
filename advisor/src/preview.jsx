// Throwaway harness for eyeballing the cards without burning an API call.
import React from 'react'
import { createRoot } from 'react-dom/client'
import ToolCard from './components/ToolCard.jsx'
import { project, compare } from '../server/retirement.js'
import { draft } from '../server/documents.js'
import './styles.css'

const base = {
  currentAge: 45, retirementAge: 65, desiredMonthlyIncome: 8000, socialSecurityMonthly: 2800,
  accounts: [
    { bucket: 'pretax', balance: 400000, annualContribution: 20000, employerMatch: 6000 },
    { bucket: 'roth', balance: 90000, annualContribution: 7000 },
    { bucket: 'taxable', balance: 150000, annualContribution: 12000 },
    { bucket: 'life', balance: 60000, annualContribution: 6000 },
  ],
}
const { years, ...summary } = project(base)
const projection = {
  ...summary,
  whatIfs: compare(base, [
    { label: 'retire at 62', changes: { retirementAge: 62 } },
    { label: 'markets 2% worse', changes: { returnBefore: 0.045, returnAfter: 0.03 } },
  ]),
}

const document_ = draft({
  documentType: 'gift_letter',
  title: 'Gift letter — down payment',
  state: 'OH',
  parties: ['[Parent full legal name]', '[Daughter full legal name]'],
  body: `I, [Parent full legal name], am giving $[amount] to my daughter, [Daughter full legal name],
toward the purchase of the property at [property address].

This is a gift. No repayment is expected, and no portion of it is a loan. Neither I nor anyone else
holds a claim, lien, or interest in the property as a result of this transfer.

The funds are coming from [account description] and will be transferred on or about [date].

Signed,
[Parent full legal name]        [date]`,
})

createRoot(window.document.getElementById('root')).render(
  <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', background: 'var(--card)' }}>
    <ToolCard name="save_accounts" result={{ accounts: 4, total: 700000, bucketsHeld: ['pretax', 'roth', 'taxable', 'life'] }} />
    <ToolCard name="run_retirement_projection" result={projection} />
    <ToolCard name="draft_document" result={document_} />
    <ToolCard name="run_retirement_projection" result={{ error: 'No accounts on file yet. Ask what they have and where it sits.' }} />
  </div>,
)
