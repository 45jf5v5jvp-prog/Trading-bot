// Sanity tests for the projection engine. No API key needed: npm test
import { project, compare } from '../server/retirement.js'

let failures = 0
const check = (name, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const base = {
  currentAge: 45,
  retirementAge: 65,
  lifeExpectancy: 92,
  desiredMonthlyIncome: 8000,
  socialSecurityMonthly: 2800,
  accounts: [
    { bucket: 'pretax', balance: 400000, annualContribution: 20000, employerMatch: 6000 },
    { bucket: 'roth', balance: 90000, annualContribution: 7000 },
    { bucket: 'taxable', balance: 150000, annualContribution: 12000 },
  ],
}

const r = project(base)

check('accumulates for the right number of years',
  r.outcome.yearsToRetirement === 20)
check('balance at 65 exceeds what was put in',
  r.atRetirement.total > 640000 + 45000 * 20,
  `$${r.atRetirement.total.toLocaleString()}`)
check('mix percentages sum to ~100',
  Math.abs(Object.values(r.atRetirement.mixPercent).reduce((a, b) => a + b, 0) - 100) < 0.5,
  JSON.stringify(r.atRetirement.mixPercent))
check('this saver reaches life expectancy',
  r.outcome.lastsToLifeExpectancy,
  r.outcome.moneyRunsOutAtAge ? `ran out at ${r.outcome.moneyRunsOutAtAge}` : `ends $${r.outcome.endingBalance.toLocaleString()}`)

// Someone spending far beyond their means should fail, and say when.
const broke = project({ ...base, desiredMonthlyIncome: 30000, socialSecurityMonthly: 0 })
check('overspending runs out and reports the age',
  !broke.outcome.lastsToLifeExpectancy && broke.outcome.moneyRunsOutAtAge > 65,
  `runs out at ${broke.outcome.moneyRunsOutAtAge}`)

// Taxable is spent before pre-tax; pre-tax is spent before Roth.
const firstSpendYear = r.years.find(y => y.phase === 'spending')
check('taxable is drawn down first',
  (firstSpendYear.balances.taxable ?? 0) < r.atRetirement.balances.taxable,
  `taxable ${r.atRetirement.balances.taxable} -> ${firstSpendYear.balances.taxable ?? 0}`)
check('Roth is left alone in year one',
  (firstSpendYear.balances.roth ?? 0) >= r.atRetirement.balances.roth * 0.99)

// RMDs are forced whether or not the money is wanted.
const rmdYears = r.years.filter(y => y.rmd > 0)
check('RMDs start at 73', rmdYears.length > 0 && rmdYears[0].age === 73,
  rmdYears.length ? `first at ${rmdYears[0].age}` : 'none')
check('lifetime forced RMDs are reported',
  r.outcome.lifetimeRmdForced > 0, `$${r.outcome.lifetimeRmdForced.toLocaleString()}`)

// A client with a modest need, all pre-tax, still gets RMD'd into a taxable account.
const allPretax = project({
  ...base, desiredMonthlyIncome: 4000,
  accounts: [{ bucket: 'pretax', balance: 1500000, annualContribution: 0 }],
})
const late = allPretax.years[allPretax.years.length - 1]
check('unneeded RMDs spill into taxable',
  (late.balances.taxable ?? 0) > 0,
  `$${(late.balances.taxable ?? 0).toLocaleString()} of taxable created by RMDs`)

// The bucket argument, in numbers: same money, different tax outcomes.
const sameMoney = 1500000
const asPretax = project({ ...base, desiredMonthlyIncome: 9000, socialSecurityMonthly: 2800,
  accounts: [{ bucket: 'pretax', balance: sameMoney }] })
const asRoth = project({ ...base, desiredMonthlyIncome: 9000, socialSecurityMonthly: 2800,
  accounts: [{ bucket: 'roth', balance: sameMoney }] })
check('all-Roth pays less lifetime tax than all-pre-tax',
  asRoth.outcome.lifetimeTaxPaid < asPretax.outcome.lifetimeTaxPaid,
  `pre-tax $${asPretax.outcome.lifetimeTaxPaid.toLocaleString()} vs Roth $${asRoth.outcome.lifetimeTaxPaid.toLocaleString()}`)
check('but both still get the client to life expectancy',
  asRoth.outcome.lastsToLifeExpectancy && asPretax.outcome.lastsToLifeExpectancy,
  'the point being that neither one is a disaster')

// What-ifs the advisor asks for out loud.
const variants = compare(base, [
  { label: 'retire at 62', changes: { retirementAge: 62 } },
  { label: 'markets do 2% worse', changes: { returnBefore: 0.045, returnAfter: 0.03 } },
])
check('comparisons return one row per variant', variants.length === 2)
check('retiring early is not strictly better',
  variants[0].endingBalance < r.outcome.endingBalance,
  `${variants[0].endingBalance.toLocaleString()} vs ${r.outcome.endingBalance.toLocaleString()}`)

// Bad inputs fail loudly rather than returning a confident wrong number.
const throws = (fn) => { try { fn(); return false } catch { return true } }
check('retiring before today is rejected',
  throws(() => project({ ...base, retirementAge: 30 })))
check('a missing income target is rejected',
  throws(() => project({ ...base, desiredMonthlyIncome: undefined })))

console.log(failures ? `\n${failures} failing` : '\nall pass')
process.exit(failures ? 1 : 0)
