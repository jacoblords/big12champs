#!/usr/bin/env node
// Exact title-game odds: enumerates every combination of remaining results (2^n finishes),
// weights each by ESPN's game probabilities, and runs the tiebreakers on each.
// Gives exact odds, exact "if X wins" splits, the provably likeliest path for each team,
// and proofs for "clinched", "eliminated", "win out and they're in" and "must" claims.
// Then, for each team, the likeliest set of results that guarantees it a title-game spot
// however the other games go (see guaranteedPath).
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

// The engine's code and this file's are part of the key, so a change to the tiebreaker rules or
// to what gets computed forces a recompute instead of reusing results from the old code.
const ENGINE_HASH = crypto.createHash("sha256").update(fs.readFileSync(require.resolve("./engine.js")))
  .update(fs.readFileSync(__filename)).digest("hex").slice(0, 12);

function inputsKey(data) {
  const parts = data.games.map((g) => [g.id, g.completed ? 1 : 0, g.winner || "", g.completed ? "" : g.pHome].join(":"));
  const fpi = data.teams.map((t) => t.id + "=" + t.fpi);
  return crypto.createHash("sha256").update(ENGINE_HASH + "#" + parts.join("|") + "#" + fpi.join(",")).digest("hex").slice(0, 16);
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
  // inBits[t]: bit m set when finish m puts team t in the title game outright (no coin toss
  // involved), or when finish m can't happen. bestSure*: likeliest finish of that kind.
  const inBits = Array.from({ length: N }, () => new Uint32Array(Math.max(1, 2 ** n >>> 5)));
  const bestSureLp = new Float64Array(N).fill(-1), bestSureMask = new Uint32Array(N);
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
    if (lp === 0) { // impossible finish (ESPN gave a game 0% / 100%)
      for (let t = 0; t < N; t++) inBits[t][m >>> 5] |= 1 << (m & 31);
      continue;
    }
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
        if (q >= 1) {
          inBits[t][m >>> 5] |= 1 << (m & 31);
          if (lp > bestSureLp[t]) { bestSureLp[t] = lp; bestSureMask[t] = m >>> 0; }
        }
      }
      if (q < 1) { cntOut[t]++; if (wonOut) woOut[t]++; }
    }
  }

  // Guaranteed paths share what's left of the time budget; a team that runs out gets none and
  // the page searches its simulations instead.
  const needs = ctx.teams.map((t, i) => {
    if (bestSureLp[i] < 0) return { need: null };
    if (elapsed() > deadline) return { need: null, needSkipped: "out of time" };
    const r = guaranteedPath(inBits[i], pH, bestSureMask[i], () => elapsed() > deadline);
    return r ? { need: r } : { need: null, needSkipped: "out of time" };
  });

  const teams = ctx.teams.map((t, i) => ({
    id: t.id,
    p: appear[i],
    first: first[i],
    pWinOut: wo[i] > 0 ? woIn[i] / wo[i] : null,
    clinched: cntOut[i] === 0,
    eliminated: cntIn[i] === 0,
    winOutGuaranteed: wo[i] > 0 && woOut[i] === 0,
    best: bestLp[i] >= 0 ? { mask: bestMask[i], prob: bestLp[i] } : null,
    ...needs[i],
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

// The likeliest set of results that guarantees a team a title-game spot: a set of games, each
// with a result, such that every finish of the other games puts the team in (inBits). Its
// probability is the product of ESPN's odds for those results. Every game in the answer is
// needed: dropping one would make the set likelier, so the search would have found that instead.
//
// Branch and bound over "cubes" (some games fixed, the rest open). Each node decides one more
// game: fixed to home win, fixed to away win, or left open for good. The bound is the probability
// mass of the finishes in the cube that could still belong to an answer: with the games ruled
// open in this branch, a finish counts only if every way those go still puts the team in. Any
// answer found below this node is a sub-cube of those finishes, so it can't be likelier.
// The game decided next is the one whose better side keeps the least of that mass.
//
// inBits: bitset over finishes. pH: home-win odds per game. startMask: a finish that puts the
// team in (the likeliest one), loosened greedily into the first answer. stop(): give up (null).
function guaranteedPath(inBits, pH, startMask, stop = () => false) {
  const n = pH.length, ALL = (2 ** n - 1) >>> 0;
  const isIn = (m) => (inBits[m >>> 5] >>> (m & 31)) & 1;
  const pr = (k, v) => (v ? pH[k] : 1 - pH[k]);
  // probability of finish m from two half tables
  const h = n >>> 1, LO = (2 ** h - 1) >>> 0;
  const half = (from, len) => {
    const a = new Float64Array(2 ** len);
    for (let x = 0; x < a.length; x++) { let w = 1; for (let k = 0; k < len; k++) w *= pr(from + k, (x >>> k) & 1); a[x] = w; }
    return a;
  };
  const lo = half(0, h), hi = half(h, n - h);
  const pm = (m) => lo[m & LO] * hi[m >>> h];
  const sufficient = (fix, vals) => {
    const free = (~fix & ALL) >>> 0;
    let sub = 0;
    do { if (!isIn((vals | sub) >>> 0)) return false; sub = (sub - free) & free; } while (sub !== 0);
    return true;
  };

  // First answer: the likeliest finish that puts the team in, with results dropped greedily
  // (least likely first) while what's left still guarantees it.
  let fix = ALL;
  const order = [...Array(n).keys()].sort((a, b) => pr(a, (startMask >>> a) & 1) - pr(b, (startMask >>> b) & 1));
  for (const k of order) {
    const f2 = (fix & ~(1 << k)) >>> 0;
    if (sufficient(f2, (startMask & f2) >>> 0)) fix = f2;
  }
  const probOf = (f, v) => { let p = 1; for (let k = 0; k < n; k++) if ((f >>> k) & 1) p *= pr(k, (v >>> k) & 1); return p; };
  let best = { games: fix, homeWins: (startMask & fix) >>> 0, prob: probOf(fix, startMask) };

  const I1 = new Float64Array(n), I0 = new Float64Array(n);
  let nodes = 0, stopped = false;
  function node(fixMask, vals, openMask, pFix) {
    if (stopped || pFix <= best.prob) return;
    if ((++nodes & 63) === 0 && stop()) { stopped = true; return; }
    const R = (~(fixMask | openMask) & ALL) >>> 0;
    // interior: assignments r of the undecided games such that every way the open games go
    // puts the team in; I1[k] is the interior mass with game k a home win
    let interior = 0, allIn = true, r = 0;
    I1.fill(0);
    do {
      const base = (vals | r) >>> 0;
      let ok = true, w = 0, o = 0;
      do {
        const m = (base | o) >>> 0;
        if (!isIn(m)) { ok = false; break; }
        w += pm(m);
        o = (o - openMask) & openMask;
      } while (o !== 0);
      if (ok) {
        interior += w;
        let b = r >>> 0;
        while (b !== 0) { const low = b & -b; I1[31 - Math.clz32(low)] += w; b = (b ^ low) >>> 0; }
      } else allIn = false;
      r = (r - R) & R;
    } while (r !== 0);
    if (allIn) { best = { games: fixMask, homeWins: vals, prob: pFix }; return; } // nothing left to decide
    if (interior <= best.prob) return;
    let k = -1, score = Infinity;
    for (let j = 0; j < n; j++) {
      if (!((R >>> j) & 1)) continue;
      const sc = Math.max(I1[j], interior - I1[j]);
      if (sc < score) { score = sc; k = j; }
    }
    const i1 = I1[k], i0 = interior - I1[k]; // children reuse I1
    const first = i1 >= i0 ? 1 : 0;
    for (const v of [first, 1 - first]) {
      if ((v ? i1 : i0) <= best.prob) continue;
      node((fixMask | (1 << k)) >>> 0, (vals | (v << k)) >>> 0, openMask, pFix * pr(k, v));
    }
    node(fixMask, vals, (openMask | (1 << k)) >>> 0, pFix);
  }
  node(0, 0, 0, 1);
  return stopped ? null : best;
}

module.exports = { solve, inputsKey, guaranteedPath, MAX_GAMES, DEFAULT_BUDGET_SEC };

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
