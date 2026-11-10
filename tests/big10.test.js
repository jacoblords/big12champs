// Big Ten tiebreakers: the league's real title games, and the places its procedure differs from
// the other leagues'. Its own published scenarios are in big10-scenarios.test.js.
// Run: node --test tests/
//
// Sources:
//   Procedure: "2024 Big Ten Football Championship Game Tiebreaker" (PDF created Aug. 23, 2024),
//     first at assets.contentstack.io/.../2024_Big_Ten_Football_Tiebreaker_-_FINAL[10][72].pdf, then
//     re-hosted byte-for-byte (same Wayback digest) at bigten.org/api/media/file/...-2024_Big_Ten_
//     Football_Tiebreaker_-_FINAL_10__72_.pdf through Oct. 2025. Both hosts are gone since the
//     conference moved to Sidearm in 2026; the Wayback copies remain. No 2025 or 2026 football
//     revision exists: the 2026 Sidearm site's only "2026_Tiebreakers.pdf" is for Olympic sports, and
//     its 2026 title-game page says "Tiebreakers will be applied, if necessary. Each team plays nine
//     conference games". So the 2024 procedure is taken as the 2026 one.
//   What it says, step by step (three or more teams; two teams use the same steps):
//     1. head-to-head among the tied teams; if not all played, a team that beat all the others is
//        in, and otherwise go on (nobody is dropped for losing to all the others);
//     2. record against all common conference opponents;
//     3. record against the next-highest common opponent in the standings, "in order of finish";
//     4. "cumulative conference winning percentage of all conference opponents";
//     5. SportSource Analytics' Team Rating Score (private: FPI stands in);
//     6. random draw.
//     "If a tiebreaker step produces standings with a clear No. 1 team by itself ... that team is
//     selected ... and the remaining teams still in contention revert to the beginning". "If a
//     tiebreaker step produces results with two teams tied for No. 1, they are both selected".
//     "If three or more teams remain tied after any step, move to next step in tiebreaker with
//     remaining tied teams" (cutContinues). "The team that is eliminated shall not be pulled back".
//   Title games (ESPN, home team = #1 seed): 2024 Penn State at Oregon; 2025 Indiana at Ohio State.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { standingsTable, seeds } = require("./helpers.js");

const fixture = (name) => JSON.parse(JSON.stringify(require(`./fixtures/${name}`)));
const B10 = B.RULES.big10;

function finalSeeds(file) {
  const ctx = B.build(fixture(file));
  assert.equal(ctx.pending.length, 0);
  const ex = B.explain(ctx, 0);
  const ab = (i) => ctx.teams[i].abbr;
  return { ctx, ex, ab, seeds: ex.seeds.map(ab) };
}

test("Big Ten data is read with Big Ten rules, and every team plays nine conference games", () => {
  for (const y of [2024, 2025]) {
    const data = fixture(`final-big10-${y}.json`);
    const ctx = B.build(data);
    assert.equal(ctx.rules, B10);
    assert.equal(ctx.teams.length, 18);
    for (let t = 0; t < ctx.N; t++) assert.equal(ctx.fixedConfW[t] + ctx.fixedConfL[t], 9, `${y} ${ctx.teams[t].abbr}`);
  }
  assert.equal(B.rulesFor("big10", 2024), B10, "one procedure for every season");
});

test("2024: Oregon alone at 9-0 is #1; Penn State beats Indiana on opponents' winning percentage", () => {
  const { ex, ab, seeds: s } = finalSeeds("final-big10-2024.json");
  assert.deepEqual(s, ["ORE", "PSU"]);
  assert.equal(ex.trace.length, 1);
  const [tb] = ex.trace;
  assert.deepEqual(tb.tied.map(ab).sort(), ["IU", "PSU"]);
  assert.equal(tb.step, "d", "both lost only to Ohio State, so steps 2 and 3 are even");
  assert.equal(ab(tb.winner), "PSU");
});

test("2025: Ohio State and Indiana both 9-0 and never met; Ohio State is #1 on step 4", () => {
  const { ex, ab, seeds: s } = finalSeeds("final-big10-2025.json");
  assert.deepEqual(s, ["OSU", "IU"]);
  assert.deepEqual(ex.groups[0].map(ab).sort(), ["IU", "OSU"]);
  assert.equal(ex.trace.length, 1);
  assert.equal(ex.trace[0].step, "d");
});

// The procedure document has no worked examples; the conference's published scenarios (in
// big10-scenarios.test.js) serve instead. Below: each place the Big Ten differs from another
// league, shown on one table that comes out differently under the two rule sets.

test("cutContinues: three left level after a cut go on to the next step, not back to head-to-head", () => {
  // A is alone at 9-0. B, C, D, E are 8-1. B beat C and D but never played E, so step 1 finds
  // nobody who beat all the others. All four played F; E lost to it, so step 2 drops E.
  // Big 12: B, C, D start over, and now B beat both others. Big Ten: they go on to step 3 (even:
  // F is the only common opponent) and step 4, where C has the best opponents' record.
  const table = (rules) => standingsTable(7, {
    records: [[9, 0], [8, 1], [8, 1], [8, 1], [8, 1], [3, 6], [2, 7]],
    beat: [[1, 2], [1, 3], [1, 5], [2, 5], [3, 5], [5, 4]],
    sos: { 1: [38, 81], 2: [44, 81], 3: [40, 81], 4: [46, 81] },
    rules,
  });
  assert.deepEqual(seeds(table(B10)), { seeds: ["A", "C"], steps: ["BCDE-E:b", "BCD>C:d"] });
  assert.deepEqual(seeds(table(B.RULES.big12)), { seeds: ["A", "B"], steps: ["BCDE-E:b", "BCD>B:a"] });
  // two left level still start over with the two-team steps
  const two = standingsTable(7, {
    records: [[9, 0], [8, 1], [8, 1], [8, 1], [8, 1], [3, 6], [2, 7]],
    beat: [[1, 2], [1, 5], [2, 5], [5, 3], [5, 4]],
    rules: B10,
  });
  assert.deepEqual(seeds(two), { seeds: ["A", "B"], steps: ["BCDE-DE:b", "BC>B:a"] });
});

test("h2hLoserOut is off: a team that lost to all the others stays in (unlike the SEC)", () => {
  // A 9-0. B, C, D 8-1: D lost to B and to C, who never met. D has the best opponents' record.
  const table = (rules) => standingsTable(4, {
    records: [[9, 0], [8, 1], [8, 1], [8, 1]],
    beat: [[1, 3], [2, 3]],
    sos: { 1: [40, 81], 2: [38, 81], 3: [45, 81] },
    rules,
  });
  assert.deepEqual(seeds(table(B10)), { seeds: ["A", "D"], steps: ["BCD>D:d"] });
  assert.deepEqual(seeds(table(B.RULES.sec)), { seeds: ["A", "B"], steps: ["BCD-D:a", "BC>B:d"] });
});

test("reseedTop2: the two teams who get in are seeded by the two-team steps (unlike the Big 12)", () => {
  // The conference's 2024 scenario 6 in miniature: A, B, C 8-1; B beat A, A beat C, B and C never
  // met. A gets in first on step 4, B beats C for the other spot, and B is #1 for beating A.
  const table = (rules) => standingsTable(3, {
    records: [[8, 1], [8, 1], [8, 1]],
    beat: [[1, 0], [0, 2]],
    sos: { 0: [45, 81], 1: [40, 81], 2: [38, 81] },
    rules,
  });
  assert.deepEqual(seeds(table(B10)).seeds, ["B", "A"]);
  assert.deepEqual(seeds(table(B.RULES.big12)).seeds, ["A", "B"]);
});

test("the standings walk counts tied opponents together (like the Big 12, unlike the SEC)", () => {
  // B and C tied for #2 at 8-1, never met. Common opponents D and E are tied 6-3, and D beat E.
  // B beat D and lost to E; C lost to D and beat E. Together the two are 1-1 for both.
  // The SEC orders D above E by head-to-head first, so B wins there.
  const table = (rules) => standingsTable(5, {
    records: [[9, 0], [8, 1], [8, 1], [6, 3], [6, 3]],
    beat: [[1, 3], [4, 1], [3, 2], [2, 4], [3, 4]],
    sos: { 1: [40, 81], 2: [42, 81] },
    rules,
  });
  assert.deepEqual(seeds(table(B10)), { seeds: ["A", "C"], steps: ["BC>C:d"] });
  assert.deepEqual(seeds(table(B.RULES.sec)), { seeds: ["A", "B"], steps: ["BC>B:c"] });
});
