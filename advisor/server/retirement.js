// Deterministic retirement projection.
//
// The model never does this arithmetic. It gathers the inputs in conversation,
// calls this as a tool, and talks about what comes back. Anything a client might
// act on has to be reproducible and inspectable, and a language model's mental
// math is neither.
//
// Everything here is a projection, not a prediction: fixed return assumptions,
// no sequence-of-returns risk, simplified taxes. The output says so, and the
// advisor should too.

// IRS Uniform Lifetime Table (post-SECURE 2.0 divisors, RMDs begin at 73).
// Verify against the current IRS publication each year — these move.
const RMD_DIVISORS = {
  73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1,
  80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2,
  87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1,
  94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4,
}
const rmdDivisor = (age) => RMD_DIVISORS[Math.min(age, 100)] ?? null

// How each kind of money behaves when it comes out. This table is the whole
// argument for holding more than one kind.
export const BUCKETS = {
  pretax:  { label: 'Pre-tax retirement',  taxedOnWithdrawal: 'ordinary', rmd: true,  order: 2 },
  roth:    { label: 'Roth',                taxedOnWithdrawal: 'none',     rmd: false, order: 4 },
  taxable: { label: 'Taxable / brokerage', taxedOnWithdrawal: 'gains',    rmd: false, order: 1 },
  cash:    { label: 'Cash',                taxedOnWithdrawal: 'none',     rmd: false, order: 0 },
  life:    { label: 'Cash value life',     taxedOnWithdrawal: 'none',     rmd: false, order: 5 },
  hsa:     { label: 'HSA',                 taxedOnWithdrawal: 'none',     rmd: false, order: 3 },
}

const DEFAULTS = {
  lifeExpectancy: 92,
  returnBefore: 0.065,
  returnAfter: 0.05,
  inflation: 0.025,
  ordinaryTaxRate: 0.22,
  capGainsRate: 0.15,
  taxableGainFraction: 0.5, // share of a taxable withdrawal treated as gain
  rmdAge: 73,
}

const round = (n) => Math.round(n)

export function project(input) {
  const a = { ...DEFAULTS, ...input }
  const {
    currentAge, retirementAge, lifeExpectancy, accounts = [],
    desiredMonthlyIncome, socialSecurityMonthly = 0, socialSecurityStartAge = 67,
    pensionMonthly = 0, pensionStartAge = retirementAge,
    returnBefore, returnAfter, inflation, ordinaryTaxRate, capGainsRate,
    taxableGainFraction, rmdAge,
  } = a

  if (!(currentAge > 0) || !(retirementAge > currentAge)) {
    throw new Error('retirementAge must be greater than currentAge')
  }
  if (!(desiredMonthlyIncome > 0)) {
    throw new Error('desiredMonthlyIncome is required — ask the client what their life costs')
  }

  // --- accumulation -------------------------------------------------------
  const balances = {}
  for (const key of Object.keys(BUCKETS)) balances[key] = 0
  const contributions = {}
  for (const key of Object.keys(BUCKETS)) contributions[key] = 0

  for (const account of accounts) {
    const bucket = BUCKETS[account.bucket] ? account.bucket : 'taxable'
    balances[bucket] += Number(account.balance) || 0
    contributions[bucket] += (Number(account.annualContribution) || 0)
      + (Number(account.employerMatch) || 0)
  }

  const startingTotal = sum(balances)
  const years = []

  for (let age = currentAge; age < retirementAge; age += 1) {
    for (const key of Object.keys(balances)) {
      // Contributions land through the year, so they earn a half year of return.
      balances[key] = balances[key] * (1 + returnBefore)
        + contributions[key] * (1 + returnBefore / 2)
    }
    years.push({
      age: age + 1,
      phase: 'saving',
      total: round(sum(balances)),
      balances: snapshot(balances),
    })
  }

  const atRetirement = snapshot(balances)
  const totalAtRetirement = sum(balances)
  const mix = Object.fromEntries(
    Object.entries(atRetirement)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => [k, Math.round((v / totalAtRetirement) * 1000) / 10]),
  )

  // --- distribution -------------------------------------------------------
  const yearsToRetirement = retirementAge - currentAge
  let needToday = desiredMonthlyIncome * 12
  let ranOutAt = null
  let lifetimeTax = 0
  let lifetimeRmdForced = 0
  let firstYearGross = 0
  let firstYearTax = 0

  const order = Object.entries(BUCKETS)
    .sort((x, y) => x[1].order - y[1].order)
    .map(([key]) => key)

  for (let age = retirementAge; age <= lifeExpectancy; age += 1) {
    const yearIndex = age - currentAge
    const inflated = needToday * Math.pow(1 + inflation, yearIndex)

    let guaranteed = 0
    if (age >= socialSecurityStartAge) {
      // Benefits are indexed too, so grow them from today's dollars as well.
      guaranteed += socialSecurityMonthly * 12 * Math.pow(1 + inflation, yearIndex)
    }
    if (pensionMonthly > 0 && age >= pensionStartAge) guaranteed += pensionMonthly * 12
    const guaranteedTax = guaranteed * ordinaryTaxRate * 0.85 // most of SS is taxable at these income levels
    let stillNeeded = Math.max(0, inflated - (guaranteed - guaranteedTax))

    let taxThisYear = guaranteedTax
    let grossThisYear = guaranteed
    let shortfall = 0

    // RMDs come out whether or not the money is needed. Anything beyond the
    // spending need lands in taxable — which is exactly why the RMD matters.
    let forcedRmd = 0
    if (age >= rmdAge && balances.pretax > 0) {
      const divisor = rmdDivisor(age)
      if (divisor) {
        forcedRmd = balances.pretax / divisor
        balances.pretax -= forcedRmd
        const tax = forcedRmd * ordinaryTaxRate
        taxThisYear += tax
        grossThisYear += forcedRmd
        lifetimeRmdForced += forcedRmd
        const net = forcedRmd - tax
        if (net >= stillNeeded) {
          balances.taxable += net - stillNeeded
          stillNeeded = 0
        } else {
          stillNeeded -= net
        }
      }
    }

    for (const key of order) {
      if (stillNeeded <= 0.01) break
      if (balances[key] <= 0) continue
      const rate = effectiveRate(key, { ordinaryTaxRate, capGainsRate, taxableGainFraction })
      // Gross up: pulling $1 of spending money costs more than $1 from a taxed bucket.
      const grossNeeded = stillNeeded / (1 - rate)
      const gross = Math.min(grossNeeded, balances[key])
      const tax = gross * rate
      balances[key] -= gross
      grossThisYear += gross
      taxThisYear += tax
      stillNeeded -= gross - tax
    }

    if (stillNeeded > 0.01) {
      shortfall = stillNeeded
      if (ranOutAt === null) ranOutAt = age
    }

    for (const key of Object.keys(balances)) balances[key] *= 1 + returnAfter

    if (age === retirementAge) {
      firstYearGross = grossThisYear
      firstYearTax = taxThisYear
    }
    lifetimeTax += taxThisYear

    years.push({
      age,
      phase: 'spending',
      needed: round(inflated),
      guaranteed: round(guaranteed),
      withdrawn: round(grossThisYear - guaranteed),
      rmd: round(forcedRmd),
      tax: round(taxThisYear),
      shortfall: round(shortfall),
      total: round(sum(balances)),
      balances: snapshot(balances),
    })
  }

  const endingBalance = sum(balances)

  return {
    assumptions: {
      currentAge, retirementAge, lifeExpectancy,
      returnBefore, returnAfter, inflation,
      ordinaryTaxRate, capGainsRate, rmdAge,
      note: 'Fixed-return projection. No market sequence risk, no state tax, simplified '
        + 'federal treatment. Useful for direction and comparison, not for filing anything.',
    },
    today: { total: round(startingTotal), balances: snapshot(balances, atRetirement && null) },
    atRetirement: {
      age: retirementAge,
      total: round(totalAtRetirement),
      balances: Object.fromEntries(Object.entries(atRetirement).map(([k, v]) => [k, round(v)])),
      mixPercent: mix,
      bucketsHeld: Object.keys(mix).length,
    },
    income: {
      desiredMonthlyToday: desiredMonthlyIncome,
      firstYearGrossWithdrawal: round(firstYearGross),
      firstYearTax: round(firstYearTax),
      effectiveTaxRateFirstYear: firstYearGross > 0
        ? Math.round((firstYearTax / firstYearGross) * 1000) / 10 : 0,
    },
    outcome: {
      lastsToLifeExpectancy: ranOutAt === null,
      moneyRunsOutAtAge: ranOutAt,
      endingBalance: round(endingBalance),
      lifetimeTaxPaid: round(lifetimeTax),
      lifetimeRmdForced: round(lifetimeRmdForced),
      yearsOfRetirement: lifeExpectancy - retirementAge,
      yearsToRetirement,
    },
    years,
  }
}

function effectiveRate(bucket, { ordinaryTaxRate, capGainsRate, taxableGainFraction }) {
  switch (BUCKETS[bucket].taxedOnWithdrawal) {
    case 'ordinary': return ordinaryTaxRate
    case 'gains': return capGainsRate * taxableGainFraction
    default: return 0
  }
}

const sum = (obj) => Object.values(obj).reduce((t, v) => t + v, 0)
const snapshot = (obj) => Object.fromEntries(
  Object.entries(obj).filter(([, v]) => v > 0).map(([k, v]) => [k, round(v)]))

// What-ifs the advisor asks for out loud: retire earlier, worse markets, spend less.
export function compare(base, variants) {
  return variants.map(({ label, changes }) => {
    try {
      const result = project({ ...base, ...changes })
      return {
        label,
        lastsToLifeExpectancy: result.outcome.lastsToLifeExpectancy,
        moneyRunsOutAtAge: result.outcome.moneyRunsOutAtAge,
        endingBalance: result.outcome.endingBalance,
        lifetimeTaxPaid: result.outcome.lifetimeTaxPaid,
      }
    } catch (err) {
      return { label, error: err.message }
    }
  })
}
