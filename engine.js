// Big 12 championship-game tiebreaker engine + Monte Carlo simulator.
// Implements the official "Big 12 Football Tiebreaking Procedures" (16-team format, 2024-).
(function (root) {
  "use strict";

  const STEP = {
    a: "Head-to-head",
    b: "Record vs. common conference opponents",
    c: "Record vs. next-highest common opponent (standings walk)",
    d: "Strength of conference schedule",
    e: "Total wins (12-game season, max 1 FCS win)",
    f: "Team rating (SportSource; ESPN FPI used as stand-in)",
    g: "Coin toss",
  };

  function build(data) {
    const teams = data.teams;
    const N = teams.length;
    const idx = {};
    teams.forEach((t, i) => (idx[t.id] = i));
    const fixedH2H = new Int8Array(N * N); // +1 row beat col
    const fixedConfW = new Int16Array(N), fixedConfL = new Int16Array(N);
    const fixedWins = new Int16Array(N), fixedFcsWins = new Int16Array(N);
    const pending = []; // games still to play involving a Big 12 team
    for (const g of data.games) {
      const h = idx[g.home], a = idx[g.away];
      if (h === undefined && a === undefined) continue;
      if (!g.completed) {
        pending.push({
          id: g.id, week: g.week, date: g.date, h, a, conf: g.conf,
          homeName: g.homeName, awayName: g.awayName,
          pHome: g.pHome == null ? 0.5 : g.pHome, pKnown: g.pHome != null,
          homeFBS: g.homeFBS, awayFBS: g.awayFBS,
        });
        continue;
      }
      if (!g.winner) continue;
      const homeWon = g.winner === g.home;
      applyResult(g.conf, h, a, homeWon, g.homeFBS, g.awayFBS, fixedH2H, fixedConfW, fixedConfL, fixedWins, fixedFcsWins, N);
    }
    return { teams, N, idx, fixedH2H, fixedConfW, fixedConfL, fixedWins, fixedFcsWins, pending };
  }

  function applyResult(conf, h, a, homeWon, homeFBS, awayFBS, H2H, CW, CL, W, FW, N) {
    if (conf) {
      const w = homeWon ? h : a, l = homeWon ? a : h;
      H2H[w * N + l] = 1; H2H[l * N + w] = -1;
      CW[w]++; CL[l]++;
    }
    // overall wins for Big 12 teams (tiebreaker e)
    if (h !== undefined && homeWon) { if (awayFBS) W[h]++; else FW[h]++; }
    if (a !== undefined && !homeWon) { if (homeFBS) W[a]++; else FW[a]++; }
  }

  // outcomes: Uint8Array over ctx.pending, 1 = home wins
  function standings(ctx, outcomes) {
    const { N } = ctx;
    const H2H = ctx.fixedH2H.slice(), CW = ctx.fixedConfW.slice(), CL = ctx.fixedConfL.slice();
    const W = ctx.fixedWins.slice(), FW = ctx.fixedFcsWins.slice();
    ctx.pending.forEach((g, i) => applyResult(g.conf, g.h, g.a, outcomes[i] === 1, g.homeFBS, g.awayFBS, H2H, CW, CL, W, FW, N));
    const total = new Int16Array(N);
    for (let t = 0; t < N; t++) total[t] = W[t] + Math.min(FW[t], 1);
    // strength of conference schedule: combined conf record of each team's conference opponents
    const sosW = new Int32Array(N), sosG = new Int32Array(N);
    for (let t = 0; t < N; t++) for (let o = 0; o < N; o++) if (H2H[t * N + o] !== 0) { sosW[t] += CW[o]; sosG[t] += CW[o] + CL[o]; }
    return { N, H2H, CW, CL, total, sosW, sosG, fpi: ctx.teams.map((t) => (t.fpi == null ? -99 : t.fpi)) };
  }

  // exact percentage comparison as fractions
  const cmpFrac = (w1, g1, w2, g2) => w1 * g2 - w2 * g1;

  function confGroups(st, exclude) {
    const ids = [];
    for (let t = 0; t < st.N; t++) if (!exclude || !exclude.has(t)) ids.push(t);
    ids.sort((x, y) => -cmpFrac(st.CW[x], st.CW[x] + st.CL[x], st.CW[y], st.CW[y] + st.CL[y]));
    const groups = [];
    for (const t of ids) {
      const last = groups[groups.length - 1];
      if (last && cmpFrac(st.CW[t], st.CW[t] + st.CL[t], st.CW[last[0]], st.CW[last[0]] + st.CL[last[0]]) === 0) last.push(t);
      else groups.push([t]);
    }
    return groups;
  }

  function recVs(st, t, opps) {
    let w = 0, g = 0;
    for (const o of opps) { const r = st.H2H[t * st.N + o]; if (r !== 0) { g++; if (r > 0) w++; } }
    return [w, g];
  }

  // unique best among T for a fraction-valued metric; returns team or -1
  function uniqueBestFrac(T, vals) {
    let best = -1, tie = false;
    for (const t of T) {
      if (best < 0) { best = t; continue; }
      const c = cmpFrac(vals[t][0], vals[t][1], vals[best][0], vals[best][1]);
      if (c > 0) { best = t; tie = false; } else if (c === 0) tie = true;
    }
    return tie ? -1 : best;
  }
  function uniqueBestNum(T, vals) {
    let best = -1, tie = false;
    for (const t of T) {
      if (best < 0) { best = t; continue; }
      if (vals[t] > vals[best]) { best = t; tie = false; } else if (vals[t] === vals[best]) tie = true;
    }
    return tie ? -1 : best;
  }

  // Step c: walk down the standings. Tied placement groups count collectively.
  // Interpretation: a group is used when every tied team played at least one member of it.
  function walk(st, T, Tset, log, names) {
    const groups = confGroups(st, Tset);
    for (const G of groups) {
      const vals = {};
      let ok = true;
      for (const t of T) { const r = recVs(st, t, G); if (r[1] === 0) { ok = false; break; } vals[t] = r; }
      if (!ok) continue;
      const best = uniqueBestFrac(T, vals);
      if (best >= 0) {
        if (log) log.detail = "vs " + G.map((g) => names[g]).join("/") + ": " + T.map((t) => names[t] + " " + vals[t][0] + "-" + (vals[t][1] - vals[t][0])).join(", ");
        return best;
      }
    }
    return -1;
  }

  // Runs the steps for a 2-team or 3+-team tie; returns the team that is seeded first.
  function pickOne(st, T, rng, trace, names) {
    if (T.length === 1) return T[0];
    const Tset = new Set(T);
    const multi = T.length > 2;
    const note = (step, winner, detail) => { if (trace) trace.push({ tied: T.slice(), step, winner, detail: typeof detail === "function" ? detail() : detail }); return winner; };
    let w, vals, detail;

    // a. head-to-head
    if (!multi) {
      const r = st.H2H[T[0] * st.N + T[1]];
      if (r !== 0) { w = r > 0 ? T[0] : T[1]; return note("a", w, () => names[w] + " beat " + names[w === T[0] ? T[1] : T[0]]); }
    } else {
      let allPlayed = true;
      for (const x of T) for (const y of T) if (x !== y && st.H2H[x * st.N + y] === 0) allPlayed = false;
      if (allPlayed) {
        vals = {}; for (const t of T) vals[t] = recVs(st, t, T);
        w = uniqueBestFrac(T, vals);
        if (w >= 0) return note("a", w, () => T.map((t) => names[t] + " " + vals[t][0] + "-" + (vals[t][1] - vals[t][0])).join(", ") + " among tied teams");
      } else {
        for (const x of T) {
          if (T.every((y) => y === x || st.H2H[x * st.N + y] > 0)) return note("a", x, () => names[x] + " beat every other tied team");
        }
      }
    }
    // b. common conference opponents (played by all tied teams)
    const common = [];
    for (let o = 0; o < st.N; o++) if (!Tset.has(o) && T.every((t) => st.H2H[t * st.N + o] !== 0)) common.push(o);
    if (common.length) {
      vals = {}; for (const t of T) vals[t] = recVs(st, t, common);
      w = uniqueBestFrac(T, vals);
      if (w >= 0) return note("b", w, () => T.map((t) => names[t] + " " + vals[t][0] + "-" + (vals[t][1] - vals[t][0])).join(", ") + " vs " + common.map((o) => names[o]).join(", "));
    }
    // c. standings walk
    const log = trace ? {} : null;
    w = walk(st, T, Tset, log, names);
    if (w >= 0) return note("c", w, log && log.detail);
    // d. strength of conference schedule
    vals = {}; for (const t of T) vals[t] = [st.sosW[t], st.sosG[t]];
    w = uniqueBestFrac(T, vals);
    if (w >= 0) return note("d", w, () => T.map((t) => names[t] + " " + (vals[t][0] / vals[t][1]).toFixed(3)).join(", "));
    // e. total wins
    w = uniqueBestNum(T, st.total);
    if (w >= 0) return note("e", w, () => T.map((t) => names[t] + " " + st.total[t]).join(", "));
    // f. rating (FPI stand-in)
    w = uniqueBestNum(T, st.fpi);
    if (w >= 0) return note("f", w, () => T.map((t) => names[t] + " " + st.fpi[t].toFixed(1)).join(", "));
    // g. coin toss
    w = T[Math.floor(rng() * T.length)];
    return note("g", w, () => "random draw");
  }

  // Returns [seed1, seed2]; trace (optional array) collects tiebreak decisions.
  function titleGame(st, rng, trace, names) {
    const groups = confGroups(st);
    const G1 = groups[0];
    if (G1.length === 1) {
      const s2 = pickOne(st, groups[1], rng, trace, names);
      return [G1[0], s2];
    }
    if (G1.length === 2) {
      // both play; head-to-head (or 2-team procedure if they did not meet) sets #1
      const s1 = pickOne(st, G1, rng, trace, names);
      return [s1, s1 === G1[0] ? G1[1] : G1[0]];
    }
    const s1 = pickOne(st, G1, rng, trace, names);
    const rest = G1.filter((t) => t !== s1);
    const s2 = pickOne(st, rest, rng, trace, names);
    return [s1, s2];
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // locks: array over pending (undefined | 0 | 1).
  // opts.uniform: sample unlocked games 50/50 and keep importance weights (for long shots).
  // opts.forceTeam: lock every game of that team to a win (unless the user locked it).
  function simulate(ctx, nSims, locks, seed, opts) {
    opts = opts || {};
    const P = ctx.pending.length, N = ctx.N;
    const rng = mulberry32(seed || 12345);
    const L = new Int8Array(P).fill(-1);
    for (let i = 0; i < P; i++) {
      if (locks && (locks[i] === 0 || locks[i] === 1)) L[i] = locks[i];
      else if (opts.forceTeam != null) {
        const g = ctx.pending[i];
        if (g.h === opts.forceTeam) L[i] = 1; else if (g.a === opts.forceTeam) L[i] = 0;
      }
    }
    const masks = new Uint32Array(nSims); // supports up to 32 pending games
    const s1 = new Uint8Array(nSims), s2 = new Uint8Array(nSims);
    const lw = opts.uniform ? new Float64Array(nSims) : null;
    const appear = new Float64Array(N), first = new Float64Array(N);
    const out = new Uint8Array(P);
    for (let s = 0; s < nSims; s++) {
      let m = 0, w = 0;
      for (let i = 0; i < P; i++) {
        let o;
        if (L[i] >= 0) o = L[i];
        else if (opts.uniform) { o = rng() < 0.5 ? 1 : 0; const p = ctx.pending[i].pHome; w += Math.log(Math.max(o ? p : 1 - p, 1e-6) / 0.5); }
        else o = rng() < ctx.pending[i].pHome ? 1 : 0;
        out[i] = o; if (o) m |= 1 << i;
      }
      masks[s] = m >>> 0;
      if (lw) lw[s] = w;
      const st = standings(ctx, out);
      const [a, b] = titleGame(st, rng);
      s1[s] = a; s2[s] = b; appear[a]++; appear[b]++; first[a]++;
    }
    return { nSims, masks, s1, s2, lw, appear, first };
  }

  function maskToOutcomes(ctx, m) {
    const o = new Uint8Array(ctx.pending.length);
    for (let i = 0; i < o.length; i++) o[i] = (m >>> i) & 1;
    return o;
  }
  function logLik(ctx, m, locks) {
    let L = 0;
    ctx.pending.forEach((g, i) => {
      if (locks && (locks[i] === 0 || locks[i] === 1)) return;
      const p = (m >>> i) & 1 ? g.pHome : 1 - g.pHome;
      L += Math.log(Math.max(p, 1e-6));
    });
    return L;
  }
  function qualifies(ctx, m, team) {
    const st = standings(ctx, maskToOutcomes(ctx, m));
    const r = titleGame(st, mulberry32(7));
    return r[0] === team || r[1] === team;
  }

  // Greedy hill-climb: flip upsets back to favorites while the team still qualifies.
  function climb(ctx, m, team, locks) {
    let improved = true;
    while (improved) {
      improved = false;
      let bestGain = 0, bestM = m;
      ctx.pending.forEach((g, i) => {
        if (locks && (locks[i] === 0 || locks[i] === 1)) return;
        const cur = (m >>> i) & 1;
        const pCur = cur ? g.pHome : 1 - g.pHome;
        if (pCur >= 0.5) return;
        const m2 = (m ^ (1 << i)) >>> 0;
        const gain = Math.log(1 - pCur) - Math.log(pCur);
        if (gain > bestGain && qualifies(ctx, m2, team)) { bestGain = gain; bestM = m2; }
      });
      if (bestM !== m) { m = bestM; improved = true; }
    }
    return m;
  }

  function bestPath(ctx, simsList, team, locks) {
    const cands = [];
    for (const S of simsList) {
      if (!S) continue;
      for (let s = 0; s < S.nSims; s++) if (S.s1[s] === team || S.s2[s] === team) cands.push(S.masks[s]);
    }
    if (!cands.length) return null;
    const uniq = Array.from(new Set(cands)).map((m) => [m, logLik(ctx, m, locks)]);
    uniq.sort((x, y) => y[1] - x[1]);
    let best = null, bestL = -Infinity;
    for (const [m0] of uniq.slice(0, 12)) {
      const m = climb(ctx, m0, team, locks);
      const L = logLik(ctx, m, locks);
      if (L > bestL) { bestL = L; best = m; }
    }
    return { mask: best, prob: Math.exp(bestL) };
  }

  // P(team appears | each outcome of each pending game)
  // Weighted when sims came from uniform exploration (self-normalised importance sampling).
  function impact(ctx, sims, team) {
    const n = sims.nSims;
    const w = new Float64Array(n);
    if (sims.lw) { let mx = -Infinity; for (let s = 0; s < n; s++) mx = Math.max(mx, sims.lw[s]); for (let s = 0; s < n; s++) w[s] = Math.exp(sims.lw[s] - mx); }
    else w.fill(1);
    let tot = 0, totQ = 0, hits = 0;
    const q = new Uint8Array(n);
    for (let s = 0; s < n; s++) { q[s] = sims.s1[s] === team || sims.s2[s] === team ? 1 : 0; tot += w[s]; if (q[s]) { totQ += w[s]; hits++; } }
    const games = ctx.pending.map((g, i) => {
      let nH = 0, qH = 0, nA = 0, qA = 0, cH = 0, cA = 0;
      for (let s = 0; s < n; s++) {
        if ((sims.masks[s] >>> i) & 1) { nH += w[s]; cH++; if (q[s]) qH += w[s]; } else { nA += w[s]; cA++; if (q[s]) qA += w[s]; }
      }
      return { cH, cA, pH: nH ? qH / nH : null, pA: nA ? qA / nA : null };
    });
    return { p: tot ? totQ / tot : 0, hits, games };
  }

  function explain(ctx, mask) {
    const st = standings(ctx, maskToOutcomes(ctx, mask));
    const names = ctx.teams.map((t) => t.abbr);
    const trace = [];
    const seeds = titleGame(st, mulberry32(7), trace, names);
    return { st, seeds, trace, groups: confGroups(st) };
  }

  const api = { STEP, build, standings, titleGame, simulate, bestPath, impact, explain, qualifies, logLik, confGroups };
  root.B12 = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
