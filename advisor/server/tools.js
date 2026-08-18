// What the advisor can actually do, as opposed to talk about.
//
// Anything with a number in it belongs here rather than in the model's head. The
// model gathers inputs in conversation, calls a tool, and talks about what came
// back — the arithmetic is reproducible and the inputs are on the record.

import { project, compare, BUCKETS } from './retirement.js'
import { draft, DOCUMENT_TYPES } from './documents.js'

const bucketEnum = Object.keys(BUCKETS)

export const TOOLS = [
  {
    name: 'record_agenda',
    description:
      'Record what the client says is important to them today, in their own words, at the top of '
      + 'the meeting. Call this as soon as they answer "what do you want to make sure we cover". '
      + 'Call it again to mark items covered as you get to them.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Their agenda in their own words — do not translate it into industry terms.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              covered: { type: 'boolean', description: 'True once you have actually addressed it.' },
            },
            required: ['text'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'record_advisor_experience',
    description:
      'Record their history with advisors and the grade they gave their current one, along with '
      + 'what would have made it an A. The gap between the grade and an A is the brief for the '
      + 'entire relationship.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['has_advisor', 'self_directed', 'between_advisors', 'never_had_one'],
        },
        grade: { type: 'string', description: 'A through F, as they said it.' },
        whatWouldMakeItAnA: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['status'],
    },
  },
  {
    name: 'save_accounts',
    description:
      'Save the accounts the client describes so everything sits in one place and the projection '
      + 'can run. Call this whenever they give you a balance or a contribution. Send the complete '
      + 'list each time — it replaces what was stored.',
    input_schema: {
      type: 'object',
      properties: {
        accounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'What the client calls it, e.g. "Fidelity 401k".' },
              bucket: {
                type: 'string',
                enum: bucketEnum,
                description: 'pretax, roth, taxable, cash, life (cash value life insurance), hsa.',
              },
              balance: { type: 'number' },
              annualContribution: { type: 'number' },
              employerMatch: { type: 'number' },
            },
            required: ['label', 'bucket', 'balance'],
          },
        },
      },
      required: ['accounts'],
    },
  },
  {
    name: 'run_retirement_projection',
    description:
      'Run the retirement projection and get real numbers back: balance at retirement, the mix '
      + 'across tax buckets, first-year tax, forced RMDs, and whether the money lasts. Use the '
      + 'saved accounts unless you are testing a what-if. Never estimate any of this yourself — '
      + 'run it. If you are missing the income target, ask for it first; that is the number the '
      + 'whole projection turns on.',
    input_schema: {
      type: 'object',
      properties: {
        currentAge: { type: 'number' },
        retirementAge: { type: 'number' },
        lifeExpectancy: { type: 'number', description: 'Defaults to 92.' },
        desiredMonthlyIncome: {
          type: 'number',
          description: 'In today\'s dollars — what their life costs per month, not what they saved.',
        },
        socialSecurityMonthly: { type: 'number' },
        socialSecurityStartAge: { type: 'number' },
        pensionMonthly: { type: 'number' },
        returnBefore: { type: 'number', description: 'Decimal, e.g. 0.065. Defaults to 6.5%.' },
        returnAfter: { type: 'number', description: 'Decimal. Defaults to 5%.' },
        inflation: { type: 'number', description: 'Decimal. Defaults to 2.5%.' },
        ordinaryTaxRate: { type: 'number', description: 'Decimal. Defaults to 22%.' },
        useSavedAccounts: {
          type: 'boolean',
          description: 'True to project the accounts already on file. Default true.',
        },
        accounts: {
          type: 'array',
          description: 'Only for a what-if that differs from what is on file.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              bucket: { type: 'string', enum: bucketEnum },
              balance: { type: 'number' },
              annualContribution: { type: 'number' },
              employerMatch: { type: 'number' },
            },
            required: ['bucket', 'balance'],
          },
        },
        whatIfs: {
          type: 'array',
          description: 'Variants to run alongside the base case — retiring earlier, worse markets, '
            + 'spending less. Stress-test out loud rather than speculating.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              retirementAge: { type: 'number' },
              desiredMonthlyIncome: { type: 'number' },
              returnBefore: { type: 'number' },
              returnAfter: { type: 'number' },
            },
            required: ['label'],
          },
        },
      },
      required: ['currentAge', 'retirementAge', 'desiredMonthlyIncome'],
    },
  },
  {
    name: 'draft_document',
    description:
      `Draft a document for the client's attorney to review. You write the full body text; this `
      + `attaches the review notice, the attorney's checklist, and flags anything missing. Types: `
      + `${Object.keys(DOCUMENT_TYPES).join(', ')}. Always tell the client plainly that their `
      + `attorney has to review it before it means anything.`,
    input_schema: {
      type: 'object',
      properties: {
        documentType: { type: 'string', enum: Object.keys(DOCUMENT_TYPES) },
        title: { type: 'string' },
        body: {
          type: 'string',
          description: 'The complete document text. Use [bracketed placeholders] for anything you '
            + 'genuinely do not know — never invent a name, date, account number, or dollar figure.',
        },
        state: { type: 'string', description: 'Two-letter state — several types turn on state law.' },
        parties: { type: 'array', items: { type: 'string' } },
      },
      required: ['documentType', 'body'],
    },
  },
]

// Every handler gets the client record and may mutate it; the caller persists.
export function runTool({ name, input, doc }) {
  switch (name) {
    case 'record_agenda': {
      doc.agenda = input.items.map((item) => ({ text: item.text, covered: Boolean(item.covered) }))
      return { saved: doc.agenda.length, agenda: doc.agenda }
    }

    case 'record_advisor_experience': {
      doc.advisorExperience = { ...input, recordedAt: new Date().toISOString() }
      return { saved: true }
    }

    case 'save_accounts': {
      doc.accounts = input.accounts.map((account) => ({
        label: account.label,
        bucket: account.bucket,
        balance: Number(account.balance) || 0,
        annualContribution: Number(account.annualContribution) || 0,
        employerMatch: Number(account.employerMatch) || 0,
      }))
      const total = doc.accounts.reduce((sum, a) => sum + a.balance, 0)
      const buckets = [...new Set(doc.accounts.map((a) => a.bucket))]
      return { accounts: doc.accounts.length, total, bucketsHeld: buckets }
    }

    case 'run_retirement_projection': {
      const { useSavedAccounts = true, accounts, whatIfs = [], ...rest } = input
      const chosen = (!useSavedAccounts && accounts?.length) ? accounts : (doc.accounts ?? [])
      if (!chosen.length) {
        return { error: 'No accounts on file yet. Ask what they have and where it sits, then call save_accounts.' }
      }

      const base = { ...rest, accounts: chosen }
      let result
      try {
        result = project(base)
      } catch (err) {
        return { error: err.message }
      }

      const variants = whatIfs.length
        ? compare(base, whatIfs.map(({ label, ...changes }) => ({ label, changes })))
        : []

      // The full year-by-year table is for the screen, not the prompt.
      const { years, ...summary } = result
      doc.lastProjection = { ...result, ranAt: new Date().toISOString() }

      return {
        ...summary,
        whatIfs: variants,
        forTheClient: 'Talk through this in plain language. Say what it assumes, and say that it is '
          + 'a projection, not a promise.',
      }
    }

    case 'draft_document': {
      const result = draft(input)
      if (!result.error) {
        doc.documents = [...(doc.documents ?? []), { ...result, draftedAt: new Date().toISOString() }]
      }
      return result
    }

    default:
      return { error: `No such tool: ${name}` }
  }
}
