/**
 * Lightweight fuzzy matcher. Returns a score (higher = better) or null if
 * the query characters can't be found in order in the target.
 *
 * Boosts:
 *  - exact substring match: large bonus
 *  - match at start of string or after word boundary: medium bonus
 *  - consecutive matched characters: small bonus
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Cheap path: exact substring.
  const idx = t.indexOf(q);
  if (idx !== -1) {
    let score = 1000 - idx; // earlier is better
    if (idx === 0) score += 200;
    else if (isBoundary(t, idx - 1)) score += 100;
    return score;
  }

  // Subsequence path.
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let cellScore = 10;
      if (ti === 0 || isBoundary(t, ti - 1)) cellScore += 30;
      if (ti === prevMatch + 1) cellScore += 15;
      score += cellScore;
      prevMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return score;
}

function isBoundary(s: string, i: number): boolean {
  const c = s[i];
  return c === " " || c === "-" || c === "_" || c === "." || c === "/";
}
