// Conference championship-game tiebreaker engine + Monte Carlo simulator.
// Implements the official Big 12, SEC, ACC and Big Ten football tiebreaking procedures (no-division
// formats, 2024-). All share one set of steps; a league picks which it uses, in order.
(function (root) {
  "use strict";

  // Steps by their Big 12 letters (step ids everywhere: traces, tests, the page).
  const STEP = {
    a: "Head-to-head",
    b: "Record vs. common conference opponents",
    c: "Record vs. next-highest common opponent (standings walk)",
    d: "Strength of conference schedule",
    e: "Total wins (12-game season, max 1 FCS win)",
    f: "Rating (Big 12, ACC, Big Ten: SportSource rating, FPI as stand-in; SEC: capped relative scoring margin)",
    g: "Coin toss",
  };

  // steps: which steps the league uses, in order. label: the league's own name for each step.
  // reseedTop2: when three or more tie for first, the two teams who get in are then seeded by
  // the two-team steps (SEC, 2025: Alabama and Georgia got in on opponents' winning percentage,
  // then Alabama was #1 for beating Georgia).
  // The Big 12 seeds them in the order they came out of the tiebreaker.
  // h2hLoserOut: with no round robin, a team that lost to every other tied team is eliminated
  // (SEC procedure 2.A.2.b); in the Big 12 it stays in.
  // walkSplitsTies: in the standings walk, a tied group of opponents is first ordered by
  // head-to-head and only counted together when that can't separate it (SEC 1.C.1); the Big 12
  // always counts the group together.
  // rating: what step f compares. "fpi": ESPN's FPI, standing in for the Big 12's private
  // SportSource rating. "margin": the SEC's capped relative total scoring margin, computed from
  // real scores with its published formula (Appendix A).
  // redefine (ACC, 2026-): teams play different numbers of conference games, so "tied" means the
  // best winning percentage plus any team with a different number of games and the same number
  // of wins or of losses as them (ACC policy 1). Every restart redefines the tie from the teams
  // still in contention, and a two-team tie's winner is only in once nobody is tied with it:
  // "starting with the highest win percentage, working downward" (2.a). See titleGameRedefine.
  // cutContinues (Big Ten): when a step drops some teams from a tie of three or more and three or
  // more are still level, they go on to the next step ("If three or more teams remain tied after
  // any step, move to next step in tiebreaker with remaining tied teams"). Elsewhere they start
  // over at step a. Two left level still start over with the two-team steps.
  // before: the rules for earlier seasons, when a league changed its procedure.
  // Labels are the leagues' own: the Big 12 letters its steps; the SEC letters them too (A-F) but
  // numbers its procedures, so the page uses numbers to keep the two apart. The ACC numbers its
  // three-team steps 1-3 (and its two-team steps i-iii).
  const NONE = { reseedTop2: false, h2hLoserOut: false, walkSplitsTies: false, redefine: false, cutContinues: false };
  // ACC 2024-2025 (policy of Aug. 2024, reworded Sept. 2025 without changing a step): the SEC's
  // steps with SportSource's Team Rating Score, and the first team out of the tiebreaker is #1.
  // Its standings walk orders tied opponents "with ties broken"; the SEC's head-to-head split
  // stands in for the full procedure.
  const ACC_2025 = { ...NONE, steps: ["a", "b", "c", "d", "f", "g"], label: { a: "a", b: "b", c: "c", d: "d", f: "e", g: "f" }, h2hLoserOut: true, walkSplitsTies: true, rating: "fpi" };
  const RULES = {
    big12: { ...NONE, steps: ["a", "b", "c", "d", "e", "f", "g"], label: { a: "a", b: "b", c: "c", d: "d", e: "e", f: "f", g: "g" }, rating: "fpi" },
    sec: { ...NONE, steps: ["a", "b", "c", "d", "f", "g"], label: { a: "1", b: "2", c: "3", d: "4", f: "5", g: "6" }, reseedTop2: true, h2hLoserOut: true, walkSplitsTies: true, rating: "margin" },
    acc: { ...NONE, steps: ["a", "f", "g"], label: { a: "1", f: "2", g: "3" }, h2hLoserOut: true, redefine: true, rating: "fpi", before: { season: 2026, rules: ACC_2025 } },
    // Big Ten (2024 procedure, unchanged through 2026): the SEC's steps with SportSource's Team
    // Rating Score; a team that lost to every other tied team stays in; tied opponents in the
    // walk count together ("their order of finish"); the two teams who get in are seeded by the
    // two-team steps (the conference's 2024 scenarios 6, 8 and 9).
    big10: { ...NONE, steps: ["a", "b", "c", "d", "f", "g"], label: { a: "1", b: "2", c: "3", d: "4", f: "5", g: "6" }, reseedTop2: true, cutContinues: true, rating: "fpi" },
  };
  function rulesFor(league, season) {
    const r = RULES[league || "big12"];
    if (!r) throw new Error("unknown league " + league);
    return r.before && season < r.before.season ? r.before.rules : r;
  }

  // SEC Appendix A, one game: points scored as a share of what the opponent allows on average
  // (capped at 200%), minus points allowed as a share of what it scores on average. In percent.
  function gameMargin(pointsFor, pointsAgainst, opp) {
    const off = opp.allowed > 0 ? Math.min((pointsFor / opp.allowed) * 100, 200) : 200;
    const def = opp.scored > 0 ? (pointsAgainst / opp.scored) * 100 : 0;
    return off - def;
  }

  // Each team's capped relative scoring margin, averaged over its finished conference games.
  // Season scoring averages come from every finished game with a score. Unplayed games have no
  // score, so in season this is the margin so far; it is exact once the season is over.
  function scoringMargins(data, idx, N) {
    const pts = new Float64Array(N), allowed = new Float64Array(N), played = new Float64Array(N);
    const scored = data.games.filter((g) => g.completed && g.homeScore != null && g.awayScore != null);
    for (const g of scored) {
      for (const [t, pf, pa] of [[idx[g.home], g.homeScore, g.awayScore], [idx[g.away], g.awayScore, g.homeScore]]) {
        if (t === undefined) continue;
        pts[t] += pf; allowed[t] += pa; played[t]++;
      }
    }
    const avg = (t) => ({ scored: pts[t] / played[t], allowed: allowed[t] / played[t] });
    const sum = new Float64Array(N), n = new Float64Array(N);
    for (const g of scored) {
      const h = idx[g.home], a = idx[g.away];
      if (!g.conf || h === undefined || a === undefined) continue;
      sum[h] += gameMargin(g.homeScore, g.awayScore, avg(a)); n[h]++;
      sum[a] += gameMargin(g.awayScore, g.homeScore, avg(h)); n[a]++;
    }
    return Array.from(sum, (x, t) => (n[t] ? x / n[t] : 0));
  }

  function build(data) {
    const rules = rulesFor(data.league, data.season);
    // Non-conference games only matter through total wins; without that step they can't change
    // the standings, so they aren't left to play (halves what exact.js enumerates for the SEC).
    const nonConfMatters = rules.steps.includes("e");
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
        if (!g.conf && !nonConfMatters) continue;
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
    const rating = rules.rating === "margin" ? scoringMargins(data, idx, N) : teams.map((t) => (t.fpi == null ? -99 : t.fpi));
    return { rules, rating, teams, N, idx, fixedH2H, fixedConfW, fixedConfL, fixedWins, fixedFcsWins, pending };
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

  const SCRATCH = typeof Symbol === "function" ? Symbol("scratch") : "_scratch";
  function scratchStandings(ctx) {
    const st = standings(ctx, new Uint8Array(ctx.pending.length));
    st[SCRATCH] = { W: new Int16Array(ctx.N), FW: new Int16Array(ctx.N) };
    return st;
  }
  // outcomes: Uint8Array over ctx.pending, 1 = home wins. into (optional): a standings object to
  // fill instead of allocating one; simulate() reuses one for every finish it plays out.
  function standings(ctx, outcomes, into) {
    const { N } = ctx;
    const st = into || { N, H2H: new Int8Array(N * N), CW: new Int16Array(N), CL: new Int16Array(N), total: new Int16Array(N),
      sosW: new Int32Array(N), sosG: new Int32Array(N), rating: ctx.rating, rules: ctx.rules };
    // overall wins (FBS, FCS) only feed total; a reused object keeps its buffers out of sight
    const W = into ? into[SCRATCH].W : new Int16Array(N), FW = into ? into[SCRATCH].FW : new Int16Array(N);
    const { H2H, CW, CL, total, sosW, sosG } = st;
    H2H.set(ctx.fixedH2H); CW.set(ctx.fixedConfW); CL.set(ctx.fixedConfL); W.set(ctx.fixedWins); FW.set(ctx.fixedFcsWins);
    const pend = ctx.pending;
    for (let i = 0; i < pend.length; i++) {
      const g = pend[i];
      applyResult(g.conf, g.h, g.a, outcomes[i] === 1, g.homeFBS, g.awayFBS, H2H, CW, CL, W, FW, N);
    }
    for (let t = 0; t < N; t++) total[t] = W[t] + Math.min(FW[t], 1);
    // strength of conference schedule: combined conf record of each team's conference opponents
    sosW.fill(0); sosG.fill(0);
    for (let t = 0; t < N; t++) {
      const row = t * N;
      for (let o = 0; o < N; o++) if (H2H[row + o] !== 0) { sosW[t] += CW[o]; sosG[t] += CW[o] + CL[o]; }
    }
    return st;
  }

  // exact percentage comparison as fractions
  const cmpFrac = (w1, g1, w2, g2) => w1 * g2 - w2 * g1;

  function confGroups(st, exclude) {
    const CW = st.CW, CL = st.CL;
    const ids = [];
    for (let t = 0; t < st.N; t++) if (!exclude || !exclude.has(t)) ids.push(t);
    // same comparison as cmpFrac, inlined: this runs for every simulated finish
    ids.sort((x, y) => CW[y] * (CW[x] + CL[x]) - CW[x] * (CW[y] + CL[y]));
    const groups = [];
    let last = null;
    for (const t of ids) {
      if (last) { const l = last[0]; if (CW[t] * (CW[l] + CL[l]) - CW[l] * (CW[t] + CL[t]) === 0) { last.push(t); continue; } }
      last = [t]; groups.push(last);
    }
    return groups;
  }

  function recVs(st, t, opps) {
    let w = 0, g = 0;
    for (const o of opps) { const r = st.H2H[t * st.N + o]; if (r !== 0) { g++; if (r > 0) w++; } }
    return [w, g];
  }

  // the teams tied for the best value at a step (fractions compared exactly)
  function topFrac(T, vals) {
    let best = T[0];
    for (const t of T) if (cmpFrac(vals[t][0], vals[t][1], vals[best][0], vals[best][1]) > 0) best = t;
    return T.filter((t) => cmpFrac(vals[t][0], vals[t][1], vals[best][0], vals[best][1]) === 0);
  }
  function topNum(T, arr) {
    let best = -Infinity;
    for (const t of T) if (arr[t] > best) best = arr[t];
    return T.filter((t) => arr[t] === best);
  }

  // Step c: walk down the standings against common opponents only. A group of teams tied in
  // the standings counts collectively, but only its members that every tied team played. The walk
  // stops at the first group that separates the tied teams and returns it with their records.
  // (2024: BYU and Iowa State "had the same results against each common opponent", so step c
  // didn't separate them and strength of schedule did.)
  // SEC: a tied group of opponents is ordered by head-to-head where it can be (two teams: the
  // winner of their game; three or more: their record against each other if they all played,
  // otherwise a team that beat, or lost to, all the others), and only counted together where
  // head-to-head can't separate it.
  function splitByH2H(st, G) {
    if (G.length < 2) return [G];
    const r = (x, y) => st.H2H[x * st.N + y];
    if (G.length === 2) {
      const v = r(G[0], G[1]);
      return v > 0 ? [[G[0]], [G[1]]] : v < 0 ? [[G[1]], [G[0]]] : [G];
    }
    const roundRobin = G.every((x) => G.every((y) => x === y || r(x, y) !== 0));
    if (roundRobin) {
      const wins = (x) => G.filter((y) => r(x, y) > 0).length;
      const levels = [...new Set(G.map(wins))].sort((a, b) => b - a);
      if (levels.length === 1) return [G];
      return levels.flatMap((w) => splitByH2H(st, G.filter((x) => wins(x) === w)));
    }
    const top = G.find((x) => G.every((y) => y === x || r(x, y) > 0));
    if (top !== undefined) return [[top], ...splitByH2H(st, G.filter((x) => x !== top))];
    const bottom = G.find((x) => G.every((y) => y === x || r(x, y) < 0));
    if (bottom !== undefined) return [...splitByH2H(st, G.filter((x) => x !== bottom)), [bottom]];
    return [G];
  }

  function walk(st, T, Tset) {
    const groups = confGroups(st, Tset);
    for (const G of st.rules.walkSplitsTies ? groups.flatMap((g) => splitByH2H(st, g)) : groups) {
      const common = G.filter((o) => T.every((t) => st.H2H[t * st.N + o] !== 0));
      if (!common.length) continue;
      const vals = {};
      for (const t of T) vals[t] = recVs(st, t, common);
      if (topFrac(T, vals).length < T.length) return { G: common, vals };
    }
    return null;
  }

  const CUT = -2; // pickOne with info.stopOnCut: teams were cut (info.cut) and nobody picked

  // Runs the steps for a 2-team or 3+-team tie; returns the team that is seeded first.
  // At each step of a 3+-team tie: a team alone at the top is seeded. Otherwise any team
  // below the best value is eliminated, and the teams still level start over at step a
  // (with the two-team steps once only two remain). This is how the Big 12 applies "if at any
  // point the multiple-team tie is reduced to two teams" (e.g. its 2025 title-game scenarios).
  // info (optional) gets .pool: the teams still in the tiebreaker when the seed was picked. Teams
  // eliminated along the way stay out: the next seed comes from the rest of that pool (2025
  // published scenario: TTU drops out of a four-way tie, ASU is #1, then BYU beats Utah for #2).
  // from (cutContinues only): the step to resume at; earlier steps are skipped.
  function pickOne(st, T, rng, trace, names, info, from) {
    if (info) info.pool = T;
    if (T.length === 1) return T[0];
    const Tset = new Set(T);
    const multi = T.length > 2;
    // trace entries: tied teams, deciding step, winner (or the teams cut), a text detail, and
    // (when there are numbers to compare) rows of {t, text, key} plus the opponents measured against
    const push = (entry, extra) => {
      if (!trace) return;
      const x = typeof extra === "function" ? extra() : extra || {};
      trace.push({ tied: T.slice(), winner: null, cut: null, rows: x.rows || null, against: x.against || null, ...entry });
    };
    const txt = (d) => (typeof d === "function" ? d() : d);
    const recRows = (v) => T.map((t) => ({ t, text: v[t][0] + "-" + (v[t][1] - v[t][0]), key: v[t][1] ? v[t][0] / v[t][1] : 0 }));
    const pctRows = (v) => T.map((t) => ({ t, text: (v[t][0] / v[t][1]).toFixed(3).replace(/^0/, ""), key: v[t][0] / v[t][1] }));
    const numRows = (arr, digits) => T.map((t) => ({ t, text: arr[t].toFixed(digits), key: arr[t] }));
    const recText = (v) => T.map((t) => names[t] + " " + v[t][0] + "-" + (v[t][1] - v[t][0])).join(", ");

    // Apply one step's result. Returns the seeded team, or -1 to go on to the next step.
    const decide = (step, top, detail, extra) => {
      if (top.length === 1) {
        if (trace) push({ step, winner: top[0], detail: txt(detail) }, extra);
        return top[0];
      }
      if (multi && top.length < T.length) {
        const cut = T.filter((t) => !top.includes(t));
        if (trace) push({ step, cut, detail: txt(detail) }, extra);
        if (info && info.stopOnCut) { info.cut = cut; return CUT; } // the caller redefines the tie
        // Big Ten: three or more still level go on to the next step; otherwise start over at a
        const next = st.rules.cutContinues && top.length > 2 ? String.fromCharCode(step.charCodeAt(0) + 1) : undefined;
        return pickOne(st, top, rng, trace, names, info, next); // the rest start over at step a
      }
      return -1;
    };
    let w, vals;
    const uses = (step) => st.rules.steps.includes(step) && (!from || step >= from);

    // a. head-to-head
    if (from && from > "a") {
      // resuming after a cut (cutContinues): head-to-head was already applied
    } else if (!multi) {
      const r = st.H2H[T[0] * st.N + T[1]];
      if (r !== 0) { w = r > 0 ? T[0] : T[1]; push({ step: "a", winner: w, detail: trace && names[w] + " beat " + names[w === T[0] ? T[1] : T[0]] }); return w; }
    } else {
      let allPlayed = true;
      for (const x of T) for (const y of T) if (x !== y && st.H2H[x * st.N + y] === 0) allPlayed = false;
      if (allPlayed) {
        vals = {}; for (const t of T) vals[t] = recVs(st, t, T);
        const v = vals;
        w = decide("a", topFrac(T, v), () => recText(v) + " among tied teams", () => ({ rows: recRows(v) }));
        if (w !== -1) return w;
      } else {
        // not everyone played: a team that beat all the others comes out. In the SEC a team that
        // lost to all the others is eliminated and the rest start over; in the Big 12 it stays in.
        for (const x of T) {
          if (T.every((y) => y === x || st.H2H[x * st.N + y] > 0)) { push({ step: "a", winner: x, detail: trace && names[x] + " beat every other tied team" }); return x; }
        }
        if (st.rules.h2hLoserOut) {
          const loser = T.find((x) => T.every((y) => y === x || st.H2H[x * st.N + y] < 0));
          if (loser !== undefined) {
            push({ step: "a", cut: [loser], detail: trace && names[loser] + " lost to every other tied team" });
            if (info && info.stopOnCut) { info.cut = [loser]; return CUT; }
            return pickOne(st, T.filter((t) => t !== loser), rng, trace, names, info);
          }
        }
      }
    }
    // b. common conference opponents (played by all tied teams)
    const common = [];
    for (let o = 0; o < st.N; o++) if (!Tset.has(o) && T.every((t) => st.H2H[t * st.N + o] !== 0)) common.push(o);
    if (common.length && uses("b")) {
      vals = {}; for (const t of T) vals[t] = recVs(st, t, common);
      const v = vals;
      w = decide("b", topFrac(T, v), () => recText(v) + " vs " + common.map((o) => names[o]).join(", "), () => ({ rows: recRows(v), against: common }));
      if (w !== -1) return w;
    }
    // c. standings walk
    const found = uses("c") && walk(st, T, Tset);
    if (found) {
      const { G, vals: v } = found;
      w = decide("c", topFrac(T, v), () => "vs " + G.map((g) => names[g]).join("/") + ": " + recText(v), () => ({ rows: recRows(v), against: G }));
      if (w !== -1) return w;
    }
    // d. strength of conference schedule
    vals = {}; for (const t of T) vals[t] = [st.sosW[t], st.sosG[t]];
    if (uses("d")) {
      const v = vals;
      w = decide("d", topFrac(T, v), () => T.map((t) => names[t] + " " + (v[t][0] / v[t][1]).toFixed(3)).join(", "), () => ({ rows: pctRows(v) }));
      if (w !== -1) return w;
    }
    // e. total wins
    if (uses("e")) {
      w = decide("e", topNum(T, st.total), () => T.map((t) => names[t] + " " + st.total[t]).join(", "), () => ({ rows: numRows(st.total, 0) }));
      if (w !== -1) return w;
    }
    // f. rating: FPI (Big 12 stand-in) or capped relative scoring margin (SEC)
    if (uses("f")) {
      w = decide("f", topNum(T, st.rating), () => T.map((t) => names[t] + " " + st.rating[t].toFixed(1)).join(", "), () => ({ rows: numRows(st.rating, 1) }));
      if (w !== -1) return w;
    }
    // g. coin toss
    w = T[Math.floor(rng() * T.length)];
    push({ step: "g", winner: w, detail: "random draw" });
    return w;
  }

  // Returns [seed1, seed2]; trace (optional array) collects tiebreak decisions.
  // Under reseedTop2, decisions that only pick who gets in are marked .spot.
  // ACC 2026 "Tied Teams" among pool: the best winning percentage, plus any team that played a
  // different number of conference games with the same wins or the same losses as one of them.
  function definedTie(st, pool) {
    const pct = (t) => [st.CW[t], st.CW[t] + st.CL[t]];
    let best = pool[0];
    for (const t of pool) if (cmpFrac(...pct(t), ...pct(best)) > 0) best = t;
    const top = pool.filter((t) => cmpFrac(...pct(t), ...pct(best)) === 0);
    const G = (t) => st.CW[t] + st.CL[t];
    const tiedTo = (t) => top.some((x) => G(x) !== G(t) && (st.CW[x] === st.CW[t] || st.CL[x] === st.CL[t]));
    return pool.filter((t) => top.includes(t) || tiedTo(t));
  }

  // ACC 2026: fill the two spots one at a time, each time defining the tie afresh from the teams
  // still in contention for that spot (everyone not yet in; teams removed are out for that spot only).
  // - A team alone in its tie is in.
  // - Policy 2.a: a tie across schedules of different lengths is "broken starting with the highest
  //   win percentage, working downward": the teams with the best percentage are settled among
  //   themselves first, and their winner meets the teams at the next percentage, and so on. (The
  //   ACC's Michael Strickland to On3, July 2026: the winner of the 8-1 vs 7-1 head-to-head "would
  //   move on to be compared to the next team".)
  // - With both spots open, that winner takes the first spot, and the tie for the second is
  //   redefined (Strickland, no 9-0 team: "the 8-1 team and the 7-1 team would be compared for the
  //   first spot ... That team gets the spot").
  // - For the last spot, a two-team comparison's loser is removed and the tie is redefined around
  //   the winner, who may now be tied with a lower team (Strickland: 9-0 in, then 8-1, 7-2, 7-1:
  //   if the 7-1 team beats the 8-1 team, "it would then be compared to the 7-2 team").
  // - A tie of three or more places a team (policy 2.b: "placed into the Championship Game"), or
  //   removes teams and starts over.
  // Seeds are in the order the teams got in; the 2026 policy doesn't say who hosts.
  function titleGameRedefine(st, rng, trace, names) {
    const placed = [];
    const pct = (t) => [st.CW[t], st.CW[t] + st.CL[t]];
    while (placed.length < 2) {
      let pool = [];
      for (let t = 0; t < st.N; t++) if (!placed.includes(t)) pool.push(t);
      for (;;) {
        const T = definedTie(st, pool);
        if (T.length === 1) { placed.push(T[0]); break; }
        // the tied teams by winning percentage, best first
        const levels = [];
        for (const t of [...T].sort((x, y) => -cmpFrac(...pct(x), ...pct(y)))) {
          const L = levels[levels.length - 1];
          if (L && cmpFrac(...pct(t), ...pct(L[0])) === 0) L.push(t); else levels.push([t]);
        }
        let cand = -1, cut = null, byThree = false;
        const beaten = [];
        for (const L of levels) {
          const tie = (cand < 0 ? L : [cand, ...L]).sort((x, y) => x - y);
          if (tie.length === 1) { cand = tie[0]; continue; }
          const info = { stopOnCut: true };
          const w = pickOne(st, tie, rng, trace, names, tie.length > 2 ? info : undefined);
          if (w === CUT) { cut = info.cut; break; }
          beaten.push(...tie.filter((t) => t !== w));
          cand = w;
          byThree = tie.length > 2;
        }
        if (cut) { pool = pool.filter((t) => !cut.includes(t)); continue; }
        // placed by a tie of three or more, or the first spot: in
        if (byThree || !placed.length) { placed.push(cand); break; }
        // the last spot, settled two at a time: the beaten teams are out, and the tie is redefined
        pool = pool.filter((t) => !beaten.includes(t));
      }
    }
    return placed;
  }

  function titleGame(st, rng, trace, names) {
    if (st.rules.redefine) return titleGameRedefine(st, rng, trace, names);
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
    // 3+ tied for first: #1 comes out of the tiebreaker; #2 comes from the teams still in it
    // when #1 was seeded (teams eliminated on the way are out).
    const info = {};
    const s1 = pickOne(st, G1, rng, trace, names, info);
    const rest = info.pool.filter((t) => t !== s1);
    const s2 = pickOne(st, rest, rng, trace, names);
    if (!st.rules.reseedTop2) return [s1, s2];
    if (trace) for (const tr of trace) tr.spot = true;
    const top = pickOne(st, [s1, s2], rng, trace, names);
    return [top, top === s1 ? s2 : s1];
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
    const scratch = scratchStandings(ctx);
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
      const st = standings(ctx, out, scratch);
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

  // The likeliest set of results that guarantees a team a title-game spot, from simulations: the
  // stand-in for exact.js's guaranteedPath when there's no full enumeration (what-ifs set, or too
  // many games left). "Guarantees" becomes "rules out every simulated finish where the team
  // misses": each such finish must disagree with the set on at least one game. Among those sets
  // the likeliest is found by branch and bound (a weighted hitting set). The answer is then
  // re-checked by simulating with its results forced; new failures join the list and it searches
  // again. Returns null when it can't settle on a set that passes, which happens for long shots,
  // whose rare winning finishes the simulations barely reach.
  //
  // simsList: simulate() results (any mix of weighted, uniform or forced runs; only which
  // finishes miss matters, not how often). locks: the visitor's picks, which stay as set.
  function guaranteedPathSim(ctx, team, simsList, locks, opts) {
    opts = opts || {};
    const verifyN = opts.verifyN || 20000, maxRounds = opts.maxRounds || 4, maxNodes = opts.maxNodes || 20000;
    const P = ctx.pending, n = P.length;
    const locked = (k) => locks && (locks[k] === 0 || locks[k] === 1);
    // cost of a result = -log of its odds; picks can't be chosen
    const cost = new Float64Array(2 * n);
    P.forEach((g, k) => {
      cost[2 * k + 1] = locked(k) ? Infinity : -Math.log(g.pHome);
      cost[2 * k] = locked(k) ? Infinity : -Math.log(1 - g.pHome);
    });
    const ins = new Set(), fails = new Set();
    for (const S of simsList) {
      if (!S) continue;
      for (let s = 0; s < S.nSims; s++) (S.s1[s] === team || S.s2[s] === team ? ins : fails).add(S.masks[s]);
    }
    if (!ins.size) return null;
    const free = P.map((g, k) => k).filter((k) => !locked(k));
    const costOf = (fix, vals) => { let c = 0; for (const k of free) if ((fix >>> k) & 1) c += cost[2 * k + ((vals >>> k) & 1)]; return c; };

    // First answer: the likeliest simulated finish that puts the team in (it disagrees with every
    // failure somewhere), with results dropped greedily, least likely first, while it still does.
    function start(F) {
      let m = -1, mc = Infinity;
      const all = free.reduce((a, k) => (a | (1 << k)) >>> 0, 0);
      for (const x of ins) { const c = costOf(all, x); if (c < mc) { mc = c; m = x; } }
      if (!isFinite(mc)) return null;
      let fix = all;
      const order = free.slice().sort((a, b) => cost[2 * b + ((m >>> b) & 1)] - cost[2 * a + ((m >>> a) & 1)]);
      for (const k of order) {
        const f2 = (fix & ~(1 << k)) >>> 0;
        let ok = true;
        for (let i = 0; i < F.length; i++) if (((F[i] ^ m) & f2) === 0) { ok = false; break; }
        if (ok) fix = f2;
      }
      return { fix, vals: (m & fix) >>> 0, cost: costOf(fix, m) };
    }

    // Branch and bound over the results to fix. Two things keep each node cheap (both leave the
    // search, and so its answer, exactly as it was):
    // - only failures the set still contains are scanned. A child fixes one more result, so its
    //   list is the parent's filtered to the failures that agree with it, in the same order; the
    //   lists live in one buffer per depth (the search is depth-first, so a depth's buffer is free
    //   again by the time a sibling needs it).
    // - a failure's cheapest ruling-out result comes from the node's usable results sorted by
    //   cost: the first one the failure disagrees with, usually the first or second looked at.
    function search(F, inc) {
      let best = inc.cost, bestFix = inc.fix, bestVals = inc.vals, nodes = 0;
      const bufs = [F];
      const optK = new Int32Array(2 * n), optV = new Int32Array(2 * n), optC = new Float64Array(2 * n);
      const order = [];
      function bb(fix, vals, ban1, ban0, c, act, nAct, depth) {
        if (++nodes > maxNodes || c >= best) return;
        // the results still usable here, cheapest first
        order.length = 0;
        for (const k of free) {
          if ((fix >>> k) & 1) continue;
          if (!((ban1 >>> k) & 1)) order.push(2 * k + 1);
          if (!((ban0 >>> k) & 1)) order.push(2 * k);
        }
        order.sort((a, b) => cost[a] - cost[b]);
        const nOpt = order.length;
        for (let j = 0; j < nOpt; j++) { optK[j] = order[j] >> 1; optV[j] = order[j] & 1; optC[j] = cost[order[j]]; }
        // Each failure the set still contains needs one more result that rules it out; the
        // cheapest such result for the hardest one bounds what's left to pay.
        let lb = 0, pick = -1;
        for (let i = 0; i < nAct; i++) {
          const f = act[i];
          let minc = Infinity;
          for (let j = 0; j < nOpt; j++) if (((f >>> optK[j]) & 1) !== optV[j]) { minc = optC[j]; break; }
          if (minc === Infinity) return; // this failure can't be ruled out in this branch
          if (minc > lb || pick < 0) { lb = Math.max(lb, minc); pick = f; }
        }
        if (pick < 0) { best = c; bestFix = fix; bestVals = vals; return; }
        if (c + lb >= best) return;
        const opts = [];
        for (const k of free) {
          if ((fix >>> k) & 1) continue;
          const v = 1 - ((pick >>> k) & 1);
          if (!(((v ? ban1 : ban0) >>> k) & 1)) opts.push([k, v, cost[2 * k + v]]);
        }
        opts.sort((a, b) => a[2] - b[2]);
        let next = bufs[depth + 1];
        if (!next) next = bufs[depth + 1] = new Uint32Array(F.length);
        for (const [k, v, ck] of opts) {
          // the failures still contained once result k is fixed to v
          let m = 0;
          for (let i = 0; i < nAct; i++) if (((act[i] >>> k) & 1) === v) next[m++] = act[i];
          bb((fix | (1 << k)) >>> 0, (vals | (v << k)) >>> 0, ban1, ban0, c + ck, next, m, depth + 1);
          // later branches may not use this result: those sets were covered here
          if (v) ban1 = (ban1 | (1 << k)) >>> 0; else ban0 = (ban0 | (1 << k)) >>> 0;
        }
      }
      bb(0, 0, 0, 0, 0, F, F.length, 0);
      return { fix: bestFix, vals: bestVals, cost: best };
    }

    for (let round = 0; round < maxRounds; round++) {
      const F = Uint32Array.from(fails);
      const inc = start(F);
      if (!inc) return null;
      const r = search(F, inc);
      const forced = P.map((g, k) => (locked(k) ? locks[k] : (r.fix >>> k) & 1 ? (r.vals >>> k) & 1 : undefined));
      const v = simulate(ctx, verifyN, forced, 7001 + round);
      let added = 0;
      for (let s = 0; s < v.nSims; s++) {
        if (v.s1[s] === team || v.s2[s] === team) ins.add(v.masks[s]);
        else if (!fails.has(v.masks[s])) { fails.add(v.masks[s]); added++; }
      }
      if (v.appear[team] === v.nSims) return { games: r.fix, homeWins: r.vals, prob: Math.exp(-r.cost), checks: verifyN };
      if (!added) return null; // only coin-toss misses left: no set guarantees it
    }
    return null;
  }

  const api = { STEP, RULES, rulesFor, gameMargin, build, standings, titleGame, simulate, bestPath, impact, explain, qualifies, logLik, confGroups, guaranteedPathSim };
  root.B12 = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
