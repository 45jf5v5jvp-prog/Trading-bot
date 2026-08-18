// Document drafting.
//
// The model writes the language — that's what it's good at. This module enforces
// the parts that cannot be left to a model's judgment: every draft carries the
// review notice, every type carries the list of things a lawyer has to check, and
// nothing is presented as executable. A draft that leaves here looks like a draft.

export const DOCUMENT_TYPES = {
  letter_of_instruction: {
    label: 'Letter of instruction',
    binding: false,
    attorneyChecklist: [
      'Confirm this does not contradict the will or trust — it does not override either',
      'Confirm the executor named here matches the one named in the will',
    ],
  },
  beneficiary_change_request: {
    label: 'Beneficiary designation change request',
    binding: true,
    attorneyChecklist: [
      'Beneficiary designations override the will — confirm this is intended',
      'Check spousal consent requirements on the plan (ERISA plans generally require it)',
      'Confirm per stirpes vs per capita language matches what the client described',
      'Confirm the custodian accepts this form; most require their own',
    ],
  },
  gift_letter: {
    label: 'Gift letter',
    binding: true,
    attorneyChecklist: [
      'Confirm the current annual exclusion amount and whether a Form 709 is required',
      'If this supports a mortgage application, confirm the lender\'s required wording',
      'Confirm the letter states clearly that repayment is not expected, if that is the intent',
    ],
  },
  promissory_note: {
    label: 'Intra-family promissory note',
    binding: true,
    stateSpecific: true,
    attorneyChecklist: [
      'Set the interest rate at or above the applicable federal rate for the term — below-market interest creates an imputed gift',
      'Confirm the note is enforceable under the state\'s statute of limitations and usury rules',
      'Decide whether the note is secured, and if so record the security interest properly',
      'Address what happens to the balance at the lender\'s death — forgiveness in a will has tax consequences',
    ],
  },
  trust_funding_letter: {
    label: 'Trust funding letter',
    binding: true,
    stateSpecific: true,
    attorneyChecklist: [
      'Confirm the exact legal name and date of the trust as executed',
      'Retitling real property requires a recorded deed — this letter does not accomplish it',
      'Confirm retirement accounts are NOT being retitled into the trust; that is usually a taxable event',
    ],
  },
  estate_intake_summary: {
    label: 'Estate planning intake summary',
    binding: false,
    attorneyChecklist: [
      'This is a summary of what the client described, not a legal instrument',
      'Verify every asset title and beneficiary designation independently — clients misremember these constantly',
    ],
  },
}

const NOTICE = 'DRAFT — NOT LEGAL ADVICE, NOT EXECUTED. Prepared to give your attorney a '
  + 'starting point and to save you billable time explaining what you want. It has not been '
  + 'reviewed by a licensed attorney and must not be signed, filed, or relied on until it has.'

export function draft({ documentType, title, body, state, parties = [] }) {
  const spec = DOCUMENT_TYPES[documentType]
  if (!spec) {
    return { error: `Unknown document type. Available: ${Object.keys(DOCUMENT_TYPES).join(', ')}` }
  }
  if (!body || body.trim().length < 120) {
    return { error: 'Draft body is too thin to be useful — write the actual document text.' }
  }

  const checklist = [...spec.attorneyChecklist]
  const gaps = []

  if (spec.stateSpecific && !state) {
    gaps.push('No state given. This document type turns on state law — ask which state before finalizing.')
  }
  if (spec.binding && !parties.length) {
    gaps.push('No parties named. A binding document needs full legal names.')
  }
  // Placeholder markers left in a draft are a feature, but they have to be flagged
  // out loud rather than shipped quietly.
  const placeholders = body.match(/\[[^\]]{2,60}\]/g) || []

  return {
    documentType,
    label: spec.label,
    title: title || spec.label,
    state: state || null,
    parties,
    document: `${NOTICE}\n\n${'—'.repeat(60)}\n\n${body.trim()}`,
    attorneyChecklist: checklist,
    gaps,
    placeholders: [...new Set(placeholders)],
    binding: spec.binding,
  }
}
