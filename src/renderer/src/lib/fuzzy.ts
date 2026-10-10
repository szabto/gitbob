/** Simple subsequence fuzzy score: higher is better, -1 if no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const t = text.toLowerCase()
  if (t.includes(q)) return 1000 - t.indexOf(q)
  let ti = 0
  let score = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    score += found === ti ? 3 : 1
    ti = found + 1
  }
  return score
}
