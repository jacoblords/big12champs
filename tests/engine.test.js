// Tiebreaker engine tests: real seasons end to end, plus one hand-built standings table per
// rule and corner case in the Big 12 policy. Run: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { standingsTable, seeds } = require("./helpers.js");

const fixture = (name) => require(`./fixtures/${name}`);
const abbr = (ctx, i) => ctx.teams[i].abbr;

test("2024 final standings: the Big 12's own ruling, step by step", () => {
  // Four teams at 7-2. ASU seeded on common opponents (4-0). Colorado "fell out first".
  // BYU and Iowa State "had the same results against each common opponent", so steps b and c
  // were even, and strength of schedule (Iowa State 36-45, BYU 31-50) put Iowa State in.
  const ctx = B.build(fixture("final-2024.json"));
  assert.equal(ctx.pending.length, 0);
  const ex = B.explain(ctx, 0);
  assert.deepEqual(ex.seeds.map((i) => abbr(ctx, i)), ["ASU", "ISU"]);
  const steps = ex.trace.map((t) => [t.tied.length, t.winner != null ? abbr(ctx, t.winner) : "-" + t.cut.map((i) => abbr(ctx, i)).join("/"), t.step]);
  assert.deepEqual(steps, [[4, "ASU", "b"], [3, "-COLO", "b"], [2, "ISU", "d"]]);
  const sos = ex.trace[2].rows;
  const byAbbr = Object.fromEntries(sos.map((r) => [abbr(ctx, r.t), r.text]));
  assert.deepEqual(byAbbr, { BYU: ".383", ISU: ".444" }); // 31/81 and 36/81
});

test("tiebreak traces carry each tied team's deciding number", () => {
  const ctx = B.build(fixture("final-2024.json"));
  const ex = B.explain(ctx, 0);
  const [first, , third] = ex.trace;
  const row = (tr, abbr) => tr.rows.find((r) => abbr === ctx.teams[r.t].abbr);
  // step b: records vs the four common opponents
  assert.equal(row(first, "ASU").text, "4-0");
  assert.equal(first.against.length, 4);
  // step d: opponents' conference win %, formatted like .452
  assert.match(row(third, "ISU").text, /^\.\d{3}$/);
  assert.ok(row(third, "ISU").key > row(third, "BYU").key);
});

test("2025 final standings: Texas Tech #1, BYU #2 (tied at 8-1, Texas Tech won head-to-head)", () => {
  const ctx = B.build(fixture("final-2025.json"));
  const ex = B.explain(ctx, 0);
  assert.deepEqual(ex.seeds.map((i) => abbr(ctx, i)), ["TTU", "BYU"]);
  assert.equal(ex.trace[0].step, "a");
});

test("title game is not counted: no team has more than 9 conference games", () => {
  for (const f of ["final-2024.json", "final-2025.json", "season-2026-11-09.json"]) {
    const ctx = B.build(fixture(f));
    const st = B.standings(ctx, new Uint8Array(ctx.pending.length));
    for (let t = 0; t < ctx.N; t++) assert.ok(st.CW[t] + st.CL[t] <= 9, `${f} ${abbr(ctx, t)}`);
  }
});

test("clear #1 and clear #2: no tiebreaker", () => {
  const r = seeds(standingsTable(4, { records: [[8, 1], [7, 2], [6, 3], [5, 4]] }));
  assert.deepEqual(r, { seeds: ["A", "B"], steps: [] });
});

test("two tied for first who played: both go, head-to-head winner is #1", () => {
  const r = seeds(standingsTable(3, { records: [[7, 2], [7, 2], [6, 3]], beat: [[1, 0]] }));
  assert.deepEqual(r.seeds, ["B", "A"]);
  assert.deepEqual(r.steps, ["AB>B:a"]);
});

test("two tied for first who did not play: both go, two-team steps set #1", () => {
  // common opponent C: A beat it, B lost to it
  const r = seeds(standingsTable(3, { records: [[7, 2], [7, 2], [6, 3]], beat: [[0, 2], [2, 1]] }));
  assert.deepEqual(r.seeds, ["A", "B"]);
  assert.deepEqual(r.steps, ["AB>A:b"]);
});

test("clear #1, two tied for second who did not play: common opponents decide #2", () => {
  const r = seeds(standingsTable(5, { records: [[8, 1], [7, 2], [7, 2], [5, 4], [4, 5]], beat: [[1, 3], [3, 2], [1, 4], [2, 4]] }));
  // common opponents of B and C: D and E. B 2-0, C 1-1.
  assert.deepEqual(r.seeds, ["A", "B"]);
  assert.deepEqual(r.steps, ["BC>B:b"]);
});

test("three-way tie, all played: best record among them is #1, the other two revert to two-team rules", () => {
  // A 2-0 vs the group; B beat C
  const r = seeds(standingsTable(3, { records: [[7, 2], [7, 2], [7, 2]], beat: [[0, 1], [0, 2], [1, 2]] }));
  assert.deepEqual(r.seeds, ["A", "B"]);
  assert.deepEqual(r.steps, ["ABC>A:a", "BC>B:a"]);
});

test("three-way tie, not all played: a team that beat every other tied team is seeded", () => {
  // C beat A and B; A and B never played
  const r = seeds(standingsTable(3, { records: [[7, 2], [7, 2], [7, 2]], beat: [[2, 0], [2, 1]], fpi: { 0: 1 } }));
  assert.deepEqual(r.seeds, ["C", "A"]);
  assert.equal(r.steps[0], "ABC>C:a");
});

test("three-way tie, not all played, nobody swept: losing to everyone does not eliminate a team", () => {
  // A beat B; C did not play A or B. Nobody beat all others -> step b. C has the best
  // record vs common opponents D,E and gets #1 even though A has a head-to-head win.
  const r = seeds(standingsTable(5, {
    records: [[7, 2], [7, 2], [7, 2], [5, 4], [5, 4]],
    beat: [[0, 1], [0, 3], [4, 0], [1, 3], [4, 1], [2, 3], [2, 4]],
  }));
  assert.equal(r.seeds[0], "C");
  assert.equal(r.steps[0], "ABC>C:b");
});

test("after a team is seeded, the rest restart at step a", () => {
  // Four-way tie, nobody swept. A seeded on common opponents (b). B, C, D then restart:
  // all three played each other and B went 2-0, so B is #2 on step a.
  const st = standingsTable(6, {
    records: [[7, 2], [7, 2], [7, 2], [7, 2], [4, 5], [4, 5]],
    beat: [[1, 2], [1, 3], [2, 3], [0, 4], [0, 5], [4, 1], [5, 1], [2, 4], [5, 2], [3, 4], [5, 3]],
  });
  const r = seeds(st);
  assert.deepEqual(r.seeds, ["A", "B"]);
  assert.deepEqual(r.steps, ["ABCD>A:b", "BCD>B:a"]);
});

test("standings walk: a tied group counts collectively, before its own tiebreak", () => {
  // B and C tie for second. Common opponents D (6-3) and F (5-4): both 1-1, so step b is even.
  // Walking down: A isn't common, so it's skipped; the D/E group counts as one, and D is the
  // only member both played: B beat D, C lost to D. B wins at step c.
  const r = seeds(standingsTable(6, {
    records: [[9, 0], [7, 2], [7, 2], [6, 3], [6, 3], [5, 4]],
    beat: [[1, 3], [5, 1], [3, 2], [2, 5]],
  }));
  assert.deepEqual(r.seeds, ["A", "B"]);
  assert.deepEqual(r.steps, ["BC>B:c"]);
});

test("standings walk only counts common opponents, even inside a tied group", () => {
  // Like BYU and Iowa State in 2024: both beat D and F, so every common opponent is even.
  // C also lost to E, which only C played. That loss must not count at step c (D and E
  // are tied in the standings), so it goes on to strength of schedule, where C is ahead.
  const r = seeds(standingsTable(6, {
    records: [[9, 0], [7, 2], [7, 2], [6, 3], [6, 3], [5, 4]],
    beat: [[1, 3], [2, 3], [1, 5], [2, 5], [4, 2]],
    sos: { 1: [40, 81], 2: [42, 81] },
  }));
  assert.deepEqual(r.seeds, ["A", "C"]);
  assert.deepEqual(r.steps, ["BC>C:d"]);
});

test("3+ team tie: teams behind at a step drop out and the rest start over", () => {
  // A, B, C tied; nobody beat both others. Common opponents D and E: A 2-0, B 2-0, C 0-2.
  // C drops out; A and B restart with the two-team steps: they played, A won.
  const r = seeds(standingsTable(6, {
    records: [[9, 0], [7, 2], [7, 2], [7, 2], [5, 4], [5, 4]],
    beat: [[1, 2], [1, 4], [1, 5], [2, 4], [2, 5], [4, 3], [5, 3]],
  }));
  assert.deepEqual(r.seeds, ["A", "B"]);
  assert.deepEqual(r.steps, ["BCD-D:b", "BC>B:a"]);
});

test("round robin among tied teams: the ones behind drop out", () => {
  // A, B, C, D all played each other: A and B 2-1, C and D 1-2. C and D drop out at step a;
  // A and B restart as a two-team tie and A won their game.
  const r = seeds(standingsTable(4, {
    records: [[7, 2], [7, 2], [7, 2], [7, 2]],
    beat: [[0, 1], [0, 2], [3, 0], [1, 2], [1, 3], [2, 3]],
  }));
  assert.equal(r.seeds[0], "A");
  assert.deepEqual(r.steps.slice(0, 2), ["ABCD-CD:a", "AB>A:a"]);
});

test("reported scenario (r/BigXII): Houston and BYU win out, Texas Tech loses to TCU", () => {
  // Texas Tech drops out of the three-way tie at 7-2 on common opponents (Baylor, Cincinnati),
  // then Houston beats BYU on common opponents, 3-1 to 2-2 (UCF is the difference).
  const ctx = B.build(fixture("season-2026-11-09.json"));
  const id = (a) => ctx.teams.findIndex((t) => t.abbr === a);
  const [HOU, BYU, TTU, TCU] = ["HOU", "BYU", "TTU", "TCU"].map(id);
  let m = 0;
  ctx.pending.forEach((g, k) => {
    let homeWins = g.pHome >= 0.5;
    if (g.h === HOU || g.h === BYU) homeWins = true;
    if (g.a === HOU || g.a === BYU) homeWins = false;
    if (g.h === TTU) homeWins = g.a !== TCU;
    if (g.a === TTU) homeWins = false;
    if (homeWins) m |= 1 << k;
  });
  const ex = B.explain(ctx, m >>> 0);
  assert.deepEqual(ex.seeds.map((i) => abbr(ctx, i)), ["UTAH", "HOU"]);
  const [cut, final] = ex.trace;
  assert.deepEqual(cut.cut.map((i) => abbr(ctx, i)), ["TTU"]);
  assert.equal(cut.step, "b");
  assert.equal(abbr(ctx, final.winner), "HOU");
  assert.equal(final.step, "b");
  assert.ok(final.against.map((o) => abbr(ctx, o)).includes("UCF"));
});

test("strength of schedule, then total wins, then rating, then coin toss", () => {
  const base = { records: [[9, 0], [7, 2], [7, 2]] };
  assert.deepEqual(seeds(standingsTable(3, { ...base, sos: { 1: [40, 81], 2: [42, 81] } })).steps, ["BC>C:d"]);
  assert.deepEqual(seeds(standingsTable(3, { ...base, total: { 1: 10, 2: 9 } })).steps, ["BC>B:e"]);
  assert.deepEqual(seeds(standingsTable(3, { ...base, fpi: { 1: 3.1, 2: 7.4 } })).steps, ["BC>C:f"]);
  const coin = seeds(standingsTable(3, base), () => 0.99);
  assert.deepEqual(coin.steps, ["BC>C:g"]);
});

test("total wins counts at most one FCS win", () => {
  // Give UCF a second FCS win (it beat Bethune-Cookman); only one may count.
  const data = JSON.parse(JSON.stringify(fixture("season-2026-11-09.json")));
  const UCF = "2116";
  const count = (d) => {
    const ctx = B.build(d);
    const allHome = new Uint8Array(ctx.pending.length).fill(1);
    return B.standings(ctx, allHome).total[ctx.idx[UCF]];
  };
  const before = count(data);
  const fcsWin = data.games.find((g) => g.completed && g.winner === UCF && !(g.home === UCF ? g.awayFBS : g.homeFBS));
  assert.ok(fcsWin, "fixture has an FCS win for UCF");
  data.games.push({ ...fcsWin, id: "test-fcs-2", week: 0, date: "2026-08-20T00:00Z" });
  assert.equal(count(data), before, "second FCS win is not counted");
  data.games.push({ ...fcsWin, id: "test-fbs", week: 0, date: "2026-08-21T00:00Z", awayFBS: true, homeFBS: true });
  assert.equal(count(data), before + 1, "an FBS win is counted");
});

test("canceled games are ignored", () => {
  const data = JSON.parse(JSON.stringify(fixture("final-2024.json")));
  const g = data.games.find((x) => x.conf && x.completed);
  const before = B.standings(B.build(data), new Uint8Array(0));
  Object.assign(g, { winner: null, canceled: true });
  const ctx = B.build(data);
  const after = B.standings(ctx, new Uint8Array(0));
  const h = ctx.idx[g.home], a = ctx.idx[g.away];
  assert.equal(after.CW[h] + after.CL[h], before.CW[h] + before.CL[h] - 1);
  assert.equal(after.CW[a] + after.CL[a], before.CW[a] + before.CL[a] - 1);
});

test("simulation is reproducible and every simulated finish seeds two different teams", () => {
  const ctx = B.build(fixture("season-2026-11-09.json"));
  const a = B.simulate(ctx, 2000, null, 5), b = B.simulate(ctx, 2000, null, 5);
  assert.deepEqual(Array.from(a.appear), Array.from(b.appear));
  for (let s = 0; s < a.nSims; s++) assert.notEqual(a.s1[s], a.s2[s]);
  assert.equal(a.appear.reduce((x, y) => x + y, 0), 2 * a.nSims);
});
