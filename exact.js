#!/usr/bin/env node
// Exact title-game odds: enumerates every combination of remaining results (2^n finishes),
// weights each by ESPN's game probabilities, and runs the tiebreakers on each.
// Gives exact odds, exact "if X wins" splits, the provably likeliest path for each team,
// and proofs for "clinched", "eliminated", "win out and they're in" and "must" claims.
//
//   node exact.js data.json      # adds/refreshes data.exact in place (skips if inputs unchanged)
//
// Time budget (EXACT_BUDGET_SECONDS, default 180): it times finishes 8k-32k (after warm-up),
// estimates the whole run, and skips if that estimate is over 80% of the budget. If a run
// still goes past the budget it stops. Either way it records why, and the page falls back to
// simulation. Each extra unplayed game doubles the work: 24 games take about 40s, so late
// season fits and early season (40+ games left) never does.
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const B = require("./engine.js");

const MAX_GAMES = 30; // masks are 32-bit; far past any realistic budget anyway
const DEFAULT_BUDGET_SEC = 180;
const ESTIMATE_SHARE = 0.8; // leave room for a slower runner than the estimate saw
// Timing window for the estimate: after the JIT has warmed up (first 8k finishes).
const WARMUP = 1 << 13, CALIBRATION = 1 << 15;

function inputsKey(data) {
  const parts = data.games.map((g) => [g.id, g.completed ? 1 : 0, g.winner || "", g.completed ? "" : g.pHome].join(":"));
  const fpi = data.teams.map((t) => t.id + "=" + t.fpi);
  return crypto.createHash("sha256").update(parts.join("|") + "#" + fpi.join(",")).digest("hex").slice(0, 16);
}

// opts.budgetSec: time allowed. opts.deadlineSec: hard stop (defaults to the budget).
function solve(data, opts = {}) {
  const budget = opts.budgetSec ?? DEFAULT_BUDGET_SEC;
  const deadline = opts.deadlineSec ?? budget;
  const clock = opts.clock || (() => performance.now());
  const ctx = B.build(data);
  const P = ctx.pending, n = P.length, N = ctx.N;
  const base = { key: inputsKey(data), gameIds: P.map((g) => g.id), games: n, budgetSec: budget };
  if (n > MAX_GAMES) return { ...base, skipped: `${n} unplayed games is too many to enumerate` };

  const own = new Uint32Array(N), ownWin = new Uint32Array(N);
  P.forEach((g, i) => {
    own[g.h] |= 1 << i; ownWin[g.h] |= 1 << i;
    own[g.a] |= 1 << i;
  });
  const appear = new Float64Array(N), first = new Float64Array(N);
  const wo = new Float64Array(N), woIn = new Float64Array(N);
  const cntIn = new Float64Array(N), cntOut = new Float64Array(N), woOut = new Float64Array(N);
  const inH = new Float64Array(N * n), cntInH = new Float64Array(N * n);
  const bestLp = new Float64Array(N).fill(-1), bestMask = new Uint32Array(N);
  const out = new Uint8Array(n);
  let coinP = 0;

  // probability of each finish, built incrementally: lp = prod over games
  const pH = P.map((g) => g.pHome);
  const total = 2 ** n;
  const t0 = clock();
  const elapsed = () => (clock() - t0) / 1000;
  let tWarm = 0;
  for (let m = 0; m < total; m++) {
    if (m === WARMUP) tWarm = clock();
    if (m === CALIBRATION) {
      const est = ((clock() - tWarm) / 1000 / (CALIBRATION - WARMUP)) * total;
      if (est > budget * ESTIMATE_SHARE) {
        return { ...base, estimateSec: Math.round(est), skipped: `${total.toLocaleString("en-US")} finishes would take about ${Math.round(est)}s, over the ${budget}s budget` };
      }
    }
    if ((m & 0xffff) === 0 && m > 0 && elapsed() > deadline) {
      return { ...base, skipped: `stopped after ${Math.round(elapsed())}s, over the ${deadline}s limit (${(m / total * 100).toFixed(0)}% done)` };
    }
    let lp = 1;
    for (let i = 0; i < n; i++) {
      const o = (m >>> i) & 1;
      out[i] = o;
      lp *= o ? pH[i] : 1 - pH[i];
    }
    if (lp === 0) continue; // impossible finish (ESPN gave a game 0% / 100%)
    const st = B.standings(ctx, out);
    let coin = false;
    const seeds = B.titleGame(st, () => { coin = true; return 0; });
    // a coin toss decides it: average over several draws
    let outcomes = [[seeds, 1]];
    if (coin) {
      coinP += lp;
      outcomes = [];
      for (let k = 0; k < 16; k++) {
        let s = 2654435761 * (k + 1) >>> 0;
        const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
        outcomes.push([B.titleGame(st, rng), 1 / 16]);
      }
    }
    const inSet = new Float64Array(N);
    for (const [[a, b], w] of outcomes) { inSet[a] += w; inSet[b] += w; first[a] += lp * w; }
    for (let t = 0; t < N; t++) {
      const q = inSet[t];
      const wonOut = ((m & own[t]) ^ ownWin[t]) === 0;
      if (wonOut) wo[t] += lp;
      if (q > 0) {
        appear[t] += lp * q;
        cntIn[t]++;
        if (wonOut) woIn[t] += lp * q;
        for (let i = 0; i < n; i++) if ((m >>> i) & 1) { inH[t * n + i] += lp * q; cntInH[t * n + i]++; }
        if (lp > bestLp[t]) { bestLp[t] = lp; bestMask[t] = m >>> 0; }
      }
      if (q < 1) { cntOut[t]++; if (wonOut) woOut[t]++; }
    }
  }

  const teams = ctx.teams.map((t, i) => ({
    id: t.id,
    p: appear[i],
    first: first[i],
    pWinOut: wo[i] > 0 ? woIn[i] / wo[i] : null,
    clinched: cntOut[i] === 0,
    eliminated: cntIn[i] === 0,
    winOutGuaranteed: wo[i] > 0 && woOut[i] === 0,
    best: bestLp[i] >= 0 ? { mask: bestMask[i], prob: bestLp[i] } : null,
    // per unplayed game: odds if home wins / if away wins, and whether the other result is impossible
    games: P.map((g, k) => {
      const ih = inH[i * n + k], ch = cntInH[i * n + k];
      return {
        pH: g.pHome > 0 ? ih / g.pHome : null,
        pA: g.pHome < 1 ? (appear[i] - ih) / (1 - g.pHome) : null,
        needH: cntIn[i] > 0 && cntIn[i] - ch === 0, // never gets in when the away team wins
        needA: cntIn[i] > 0 && ch === 0,
      };
    }),
  }));
  return { ...base, finishes: total, elapsedSec: Math.round(elapsed()), coinTossShare: coinP, teams };
}

module.exports = { solve, inputsKey, MAX_GAMES, DEFAULT_BUDGET_SEC };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node exact.js data.json"); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = inputsKey(data);
  if (data.exact && data.exact.key === key) { console.log(`exact odds already current (${key})`); process.exit(0); }
  const t0 = Date.now();
  const budgetSec = Number(process.env.EXACT_BUDGET_SECONDS) || DEFAULT_BUDGET_SEC;
  data.exact = solve(data, { budgetSec });
  data.exact.computedAt = new Date().toISOString().slice(0, 16) + "Z";
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  console.log(data.exact.skipped ? `exact odds skipped: ${data.exact.skipped}` :
    `exact odds over ${data.exact.finishes.toLocaleString("en-US")} finishes in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
