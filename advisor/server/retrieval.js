// Lexical retrieval (BM25) over your recorded answers.
//
// Why not embeddings: BM25 needs no extra service, no extra key, and is easy to
// eyeball when a bad example gets pulled. It's strong on the vocabulary you
// actually use ("Roth conversion", "sequence of returns"). The upgrade path is
// to swap scoreAll() for a vector search once the corpus is a few hundred entries.

const STOP = new Set(('a an and are as at be but by for from how i if in into is it my of on or '
  + 'should so than that the their then there these they this to was what when where which who '
  + 'why will with would you your do does did can could our we me').split(' '))

const K1 = 1.4
const B = 0.72

const tokenize = (text) =>
  text.toLowerCase().match(/[a-z0-9']+/g)?.filter((t) => t.length > 1 && !STOP.has(t)) ?? []

export function buildIndex(entries) {
  const docs = entries.map((entry) => {
    // The question is weighted by repeating it — a client's phrasing matches
    // the question you were asked far more often than the body of your answer.
    const terms = [...tokenize(entry.question), ...tokenize(entry.question), ...tokenize(entry.answer)]
    const tf = new Map()
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { entry, tf, len: terms.length }
  })

  const df = new Map()
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)

  const avgLen = docs.reduce((sum, d) => sum + d.len, 0) / (docs.length || 1)
  const N = docs.length

  return {
    size: N,
    search(query, limit = 5) {
      const qTerms = tokenize(query)
      if (!N || !qTerms.length) return []
      const scored = docs.map((doc) => {
        let score = 0
        for (const term of qTerms) {
          const f = doc.tf.get(term)
          if (!f) continue
          const idf = Math.log(1 + (N - df.get(term) + 0.5) / (df.get(term) + 0.5))
          score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / avgLen)))
        }
        return { entry: doc.entry, score }
      })
      return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
  }
}
