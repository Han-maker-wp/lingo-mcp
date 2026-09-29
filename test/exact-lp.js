'use strict';

/**
 * A tiny exact rational LP solver used to cross-check LINGO's answers in the
 * test suite. It enumerates every basic feasible solution of the standard form
 * (slack-variable) representation, so it shares no code or assumptions with the
 * solver under test. Exact arithmetic means the comparison has no rounding slack.
 */

class Frac {
  constructor(n, d = 1n) {
    if (d === 0n) throw new Error('division by zero');
    let nn = BigInt(n), dd = BigInt(d);
    if (dd < 0n) { nn = -nn; dd = -dd; }
    const g = (function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a < 0n ? -a : a; })(nn, dd);
    this.n = nn / g; this.d = dd / g;
  }
  static of(v) { return v instanceof Frac ? v : new Frac(Math.round(v * 1e9), 1000000000n); }
  add(o) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Frac(this.n * o.n, this.d * o.d); }
  div(o) { return new Frac(this.n * o.d, this.d * o.n); }
  neg() { return new Frac(-this.n, this.d); }
  isNeg() { return this.n < 0n; }
  isZero() { return this.n === 0n; }
  eq(o) { return this.n === o.n && this.d === o.d; }
  toNumber() { return Number(this.n) / Number(this.d); }
  toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
}

function combos(n, k) {
  const out = [];
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k > n) return out;
  for (;;) {
    out.push(idx.slice());
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

/** Solve a square rational system by Gauss-Jordan; null when singular. */
function solveSquare(A, b) {
  const m = A.length;
  const M = A.map((row, i) => row.map((v) => Frac.of(v)).concat([Frac.of(b[i])]));
  for (let col = 0; col < m; col++) {
    let piv = -1;
    for (let r = col; r < m; r++) if (!M[r][col].isZero()) { piv = r; break; }
    if (piv === -1) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const inv = new Frac(M[col][col].d, M[col][col].n);   // d/n — the reciprocal of n/d
    for (let c = col; c <= m; c++) M[col][c] = M[col][c].mul(inv);
    for (let r = 0; r < m; r++) {
      if (r === col || M[r][col].isZero()) continue;
      const f = M[r][col];
      for (let c = col; c <= m; c++) M[r][c] = M[r][c].sub(f.mul(M[col][c]));
    }
  }
  return M.map((row) => row[m]);
}

/**
 * Maximize (or minimize) c'x subject to A x {<=,>=,=} b, x >= 0.
 * Returns { status: 'optimal'|'infeasible', value, x }.
 * Vertex enumeration says nothing about unboundedness — callers treat 'optimal'
 * as "bounded and solved".
 */
function exactLp({ c, A, rel, b, sense = 'max' }) {
  const m = A.length;
  const n = c.length;
  // Standard form: Ax ± S = b with every variable (and slack) non-negative.
  // A '<=' row needs +S (so S = b - Ax >= 0 iff Ax <= b); a '>=' row needs -S.
  // Every row is built at full width N so column j means the same thing in each row.
  const zero = () => Frac.of(0);
  const slackCount = rel.filter((r) => r === '<=' || r === '>=').length;
  const N = n + slackCount;
  const rows = [];
  let sIdx = n;
  for (let i = 0; i < m; i++) {
    const row = new Array(N).fill(null).map(zero);
    for (let j = 0; j < n; j++) row[j] = Frac.of(A[i][j]);
    if (rel[i] === '<=') { row[sIdx++] = Frac.of(1); }
    else if (rel[i] === '>=') { row[sIdx++] = Frac.of(-1); }
    rows.push(row);
  }
  const obj = new Array(N).fill(null).map(zero);
  for (let j = 0; j < n; j++) obj[j] = Frac.of(c[j]);
  const rhs = b.map((v) => Frac.of(v));
  const sign = sense === 'max' ? 1 : -1;

  let best = null;
  let feasibleCount = 0;
  for (const basis of combos(N, m)) {
    const inBasis = new Set(basis);
    const Aeq = rows.map((row) => basis.map((j) => row[j]));
    const sol = solveSquare(Aeq, rhs);
    if (!sol) continue;
    if (sol.some((v) => v.isNeg())) continue;      // some variable is negative
    const full = Array.from({ length: N }, (_, j) => (inBasis.has(j) ? null : Frac.of(0)));
    basis.forEach((j, k) => { full[j] = sol[k]; });
    if (full.some((v) => v.isNeg())) continue;
    feasibleCount++;
    const val = obj.reduce((acc, oj, j) => acc.add(oj.mul(full[j])), Frac.of(0));
    if (best === null || sign * val.toNumber() > sign * best.value.toNumber()) {
      best = { value: val, x: full.slice(0, n) };
    }
  }
  if (best === null) return { status: 'infeasible', feasibleCount };
  return {
    status: 'optimal',
    value: best.value.toNumber(),
    x: best.x.map((v) => v.toNumber()),
    feasibleCount,
  };
}

module.exports = { exactLp, Frac };
