// ACC tiebreakers: the league's real title games, the ACC's own explanation of its 2026 procedure,
// and the places it differs from the Big 12's and the SEC's. Run: node --test tests/
//
// The ACC changed its procedure for 2026, so the engine keeps both (RULES.acc and
// RULES.acc.before.rules, chosen by season).
//
// Sources:
//   2026-: "Atlantic Coast Conference Football Tiebreaker Policy (As Amended July 1, 2026)",
//     https://s3.amazonaws.com/sidearm.sites/acc.sidearmsports.com/documents/2026/7/15/ACC_Football_Tiebreaker_Policy_Jully_2026.pdf
//     (announced July 15, 2026, theacc.com). Tied Teams are the best conference winning
//     percentage plus any team with a different number of conference games and the same wins or
//     the same losses (1). Two teams: head-to-head, SportSource Team Success Ranking, draw (2.b).
//     Three or more: record among the tied teams if all played each other; otherwise a team that
//     beat all the others is in and one that lost to all the others is out; then the ranking
//     places a team; then a draw. "If necessary, the tiebreaker will restart, including the
//     definition of tied teams." Ties across different numbers of games are broken "starting with
//     the highest win percentage, working downward" (2.a). No worked examples, and nothing on
//     seeding.
//   Worked examples: the ACC's vice president of football, Michael Strickland, walked On3 through
//     two (Andy Staples, "Explaining the new ACC tiebreaker if a 7-1, 8-1 and 7-2 team somehow
//     wind up 'tied'", On3, July 15, 2026). Replayed below.
//   2024-2025: "Tiebreaker Policy", https://theacc.com/documents/2023/5/17/ACC_FOOTBALL_TIEBREAKER_POLICY.pdf
//     (served from S3; version of Aug. 6, 2024, reworded Sept. 4, 2025 with the same steps).
//     Two teams: head-to-head, common opponents, common opponents by order of finish "with ties
//     broken", combined win % of conference opponents, SportSource Team Rating Score, draw. Three
//     or more: head-to-head if all played; otherwise beat-all in, lost-all out; then the same.
//     "The team with the highest win percentage, either outright or after application of the
//     tiebreaker" is #1 (2024: "number one seed"; 2025: "home team").
//   Title games (ESPN, home team = #1 seed; both neutral-site in Charlotte): 2024 Clemson at SMU;
//     2025 Duke at Virginia.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { standingsTable, seeds } = require("./helpers.js");

const fixture = (name) => JSON.parse(JSON.stringify(require(`./fixtures/${name}`)));
const ACC = B.RULES.acc;
const ACC_2025 = ACC.before.rules;

function finalSeeds(data) {
  const ctx = B.build(data);
  assert.equal(ctx.pending.length, 0);
  const ex = B.explain(ctx, 0);
  const ab = (i) => ctx.teams[i].abbr;
  return { ctx, ex, ab, seeds: ex.seeds.map(ab) };
}

test("ACC data is read with the rules of its season", () => {
  const d = fixture("final-acc-2025.json");
  assert.equal(B.build(d).rules, ACC_2025);
  assert.equal(B.build({ ...d, season: 2024 }).rules, ACC_2025);
  assert.equal(B.build({ ...d, season: 2026 }).rules, ACC);
  assert.equal(B.rulesFor("sec", 2024), B.RULES.sec, "leagues without a change use one set");
});

test("ACC step labels: 2026 numbers its three steps; 2024-25 lettered six", () => {
  assert.deepEqual(ACC.steps.map((s) => ACC.label[s]), ["1", "2", "3"]);
  assert.deepEqual(ACC.steps, ["a", "f", "g"]);
  assert.deepEqual(ACC_2025.steps.map((s) => ACC_2025.label[s]).join(""), "abcdef");
});

// ---- The real title games, under the rules they were played under ----

test("2024: SMU 8-0 and Clemson 7-1, no tiebreak", () => {
  const { ex, seeds: s } = finalSeeds(fixture("final-acc-2024.json"));
  assert.deepEqual(s, ["SMU", "CLEM"]);
  assert.equal(ex.trace.length, 0);
});

test("2025: Virginia 7-1 is #1; Duke wins a five-way tie at 6-2 on opponents' winning percentage", () => {
  const { ex, ab, seeds: s, ctx } = finalSeeds(fixture("final-acc-2025.json"));
  assert.equal(ctx.teams.length, 17);
  assert.deepEqual(s, ["UVA", "DUKE"]);
  assert.equal(ex.trace.length, 1);
  const [tb] = ex.trace;
  assert.deepEqual(tb.tied.map(ab).sort(), ["DUKE", "GT", "MIA", "PITT", "SMU"]);
  for (const t of tb.tied) assert.equal(`${ex.st.CW[t]}-${ex.st.CL[t]}`, "6-2");
  // Nobody beat or lost to all the others, and the five had no common opponent, so it went to
  // combined win % of conference opponents: Duke .500, Georgia Tech and Miami .438, Pitt and SMU .422.
  assert.equal(tb.step, "d");
  assert.equal(ab(tb.winner), "DUKE");
  assert.deepEqual(tb.rows.map((r) => `${ab(r.t)} ${r.text}`).sort(), ["DUKE .500", "GT .438", "MIA .438", "PITT .422", "SMU .422"]);
});

test("2025 under the 2026 rules: the ranking step decides, and sends Miami (FPI standing in)", () => {
  // Press coverage of the new policy said it "would have sent Miami to Charlotte instead of Duke"
  // (Shakin the Southland, July 16, 2026). Here FPI stands in for SportSource's private ranking.
  const { ex, ab, seeds: s } = finalSeeds({ ...fixture("final-acc-2025.json"), season: 2026 });
  assert.deepEqual(s, ["UVA", "MIA"]);
  assert.deepEqual(ex.trace.map((t) => t.step), ["f"]);
  assert.equal(ex.trace[0].tied.length, 5);
  assert.ok(ab(ex.trace[0].winner) === "MIA");
});

// ---- The ACC's own examples (Strickland to On3, July 2026) ----
// Teams play 8 or 9 conference games in 2026. A 9-game team at 8-1 is tied with an 8-game team at
// 7-1 (same losses); a 9-game 7-2 team is tied with the 7-1 team (same wins) but not with 8-1.
const acc = (opts) => seeds(standingsTable(opts.records.length, { rules: ACC, ...opts }));
// A 9-0; B 8-1 (9 games); C 7-2 (9 games); D 7-1 (8 games); E 4-5.
const SCENARIO_1 = [[9, 0], [8, 1], [7, 2], [7, 1], [4, 5]];

test("ACC example 1: 9-0 is in; the 8-1 team beats the 7-1 team and takes the last spot", () => {
  // "the 8-1 team gets the second title game spot because it has the superior win percentage
  // compared to the 7-2 team and they played the same number of conference games"
  assert.deepEqual(acc({ records: SCENARIO_1, beat: [[1, 3], [2, 3]] }), { seeds: ["A", "B"], steps: ["BD>B:a"] });
});

test("ACC example 1: if the 7-1 team wins, it is then compared with the 7-2 team", () => {
  // "If the 7-1 team prevailed, it would then be compared to the 7-2 team using the head-to-head
  // (if available) or the SportsSource Analytics ranking"
  assert.deepEqual(acc({ records: SCENARIO_1, beat: [[3, 1], [3, 2]] }), { seeds: ["A", "D"], steps: ["BD>D:a", "CD>D:a"] });
  assert.deepEqual(acc({ records: SCENARIO_1, beat: [[3, 1], [2, 3]] }), { seeds: ["A", "C"], steps: ["BD>D:a", "CD>C:a"] });
  // didn't play: the ranking, both times
  assert.deepEqual(acc({ records: SCENARIO_1, rating: [0, 10, 30, 20, 0] }), { seeds: ["A", "C"], steps: ["BD>D:f", "CD>C:f"] });
});

test("ACC example 2: no 9-0 team; 8-1 and 7-1 are both in, and the 7-2 team can't pass the 8-1 team", () => {
  // "the 8-1 team and the 7-1 team would be compared for the first spot ... Let's say they didn't
  // play and the 7-1 team has the higher ranking. That team gets the spot and the 8-1 team would
  // be compared to the 7-2 team ... 'A 7-2 team would never win a tie against an 8-1 team because
  // they weren't tied in the first place.'" Even beating both doesn't help the 7-2 team.
  const records = [[4, 5], [8, 1], [7, 2], [7, 1], [4, 5]];
  const r = acc({ records, beat: [[2, 1], [2, 3]], rating: [0, 10, 30, 20, 0] });
  assert.deepEqual(r, { seeds: ["D", "B"], steps: ["BD>D:f"] });
});

test("ACC vs Big 12: the 8-1 team doesn't automatically rank ahead of a 7-1 team", () => {
  const table = (rules) => standingsTable(5, { rules, records: SCENARIO_1, beat: [[3, 1], [3, 2]] });
  assert.deepEqual(seeds(table(ACC)).seeds, ["A", "D"]);
  assert.deepEqual(seeds(table(B.RULES.big12)), { seeds: ["A", "B"], steps: [] }, "winning percentage alone");
  assert.deepEqual(seeds(table(B.RULES.sec)), { seeds: ["A", "B"], steps: [] });
});

// ---- The rest of the 2026 procedure, from the policy text ----

test("2026, three-way tie, all played each other: best record among them is in", () => {
  // X 8-1 alone; A, B, C 7-2; A beat B and C, B beat C.
  const r = acc({ records: [[7, 2], [7, 2], [7, 2], [8, 1]], beat: [[0, 1], [0, 2], [1, 2]] });
  assert.deepEqual(r, { seeds: ["D", "A"], steps: ["ABC>A:a"] });
});

test("2026, three-way tie in a cycle: the ranking places a team", () => {
  const r = acc({ records: [[7, 2], [7, 2], [7, 2], [8, 1]], beat: [[0, 1], [1, 2], [2, 0]], rating: [5, 15, 10, 0] });
  assert.deepEqual(r, { seeds: ["D", "B"], steps: ["ABC>B:f"] });
});

test("2026, not all played: a team that beat the others is in; one that lost to the others is out", () => {
  // A beat B and C, B and C didn't play.
  assert.deepEqual(acc({ records: [[7, 2], [7, 2], [7, 2], [8, 1]], beat: [[0, 1], [0, 2]] }), { seeds: ["D", "A"], steps: ["ABC>A:a"] });
  // C lost to A and B, who didn't play: C is out, A and B start over as a two-team tie.
  const r = acc({ records: [[7, 2], [7, 2], [7, 2], [8, 1]], beat: [[0, 2], [1, 2]], rating: [5, 15, 50, 0] });
  assert.deepEqual(r, { seeds: ["D", "B"], steps: ["ABC-C:a", "AB>B:f"] });
});

test("2026: two teams level on the best record among four start over as a two-team tie", () => {
  // Four 7-2 teams all played each other: A and B 2-1, C and D 1-2. C and D are out; A and B
  // start over, and B beat A.
  const records = [[7, 2], [7, 2], [7, 2], [7, 2], [8, 1]];
  const beat = [[0, 2], [0, 3], [1, 0], [1, 3], [2, 1], [3, 2]];
  assert.deepEqual(acc({ records, beat }), { seeds: ["E", "B"], steps: ["ABCD-CD:a", "AB>B:a"] });
});

test("2026: a team placed out of a three-way tie, then the tie is redefined for the last spot", () => {
  // A 8-1 (9 games), B and C 7-1 (8 games): all tied (same losses). D 7-2 (9 games) is tied with
  // B and C (same wins) but not with A, so it isn't in the first tie. Nobody played anybody.
  // The ranking places B. For the last spot: A is the best left, tied with C; C wins on the
  // ranking, and is now tied with D; D wins. D at 7-2 is in over A at 8-1.
  const r = acc({ records: [[8, 1], [7, 1], [7, 1], [7, 2], [4, 4]], rating: [10, 30, 20, 25, 0] });
  assert.deepEqual(r, { seeds: ["B", "D"], steps: ["ABC>B:f", "AC>C:f", "CD>D:f"] });
});

test("2026: two teams tied for first are both in; head-to-head, then the ranking, seeds them", () => {
  assert.deepEqual(acc({ records: [[7, 1], [7, 1], [6, 2]], beat: [[1, 0]] }), { seeds: ["B", "A"], steps: ["AB>B:a"] });
  assert.deepEqual(acc({ records: [[7, 1], [7, 1], [6, 2]], rating: [3, 1, 9] }), { seeds: ["A", "B"], steps: ["AB>A:f"] });
});

test("2026: only head-to-head and the ranking: common opponents and schedule strength don't count", () => {
  // X 8-1; B and C 7-2, didn't play. C did better against common opponents D and E, and had the
  // tougher schedule; B is ranked higher. Big 12: C on common opponents. ACC: B on the ranking.
  const opts = {
    records: [[8, 1], [7, 2], [7, 2], [4, 5], [4, 5]],
    beat: [[3, 1], [2, 3], [2, 4], [1, 4]],
    sos: { 1: [30, 81], 2: [50, 81] },
    rating: [0, 20, 10, 0, 0],
  };
  assert.deepEqual(seeds(standingsTable(5, opts)).steps, ["BC>C:b"]);
  assert.deepEqual(acc(opts).steps, ["BC>B:f"]);
});

test("2026: equal schedules behave like the 2024-25 head-to-head steps", () => {
  // With every team on nine games the definition adds no one: first place goes to the best record,
  // ties of two go head-to-head.
  const r = acc({ records: [[8, 1], [7, 2], [7, 2], [5, 4]], beat: [[2, 1]] });
  assert.deepEqual(r, { seeds: ["A", "C"], steps: ["BC>C:a"] });
});

// ---- 2024-25 rules: the switches it shares with the SEC, and the one it doesn't ----

test("2024-25: a team that lost to every other tied team is out, as in the SEC", () => {
  // X 7-1; A, B, C 6-2; C lost to A and B, A and B didn't play. Common opponent D (4-4): A beat
  // and C beat it, B lost to it. Big 12: C stays in, step b (A 1-0, B 0-1, C 1-0) drops B, and A
  // beats C head-to-head. ACC: C is out first, then A over B on common opponents.
  const opts = { records: [[6, 2], [6, 2], [6, 2], [4, 4], [7, 1]], beat: [[0, 2], [1, 2], [0, 3], [3, 1], [2, 3]], fpi: { 2: 9 } };
  assert.deepEqual(seeds(standingsTable(5, { ...opts, rules: ACC_2025 })), { seeds: ["E", "A"], steps: ["ABC-C:a", "AB>A:b"] });
  assert.deepEqual(seeds(standingsTable(5, opts)).steps, ["ABC-B:b", "AC>A:a"]);
});

test("2024-25: three tied for first are seeded in the order they come out (no SEC re-seeding)", () => {
  // The SEC test's table: A in on common opponents, then B over C; B beat A. SEC re-seeds B #1.
  const table = (rules) => standingsTable(5, {
    rules,
    records: [[7, 1], [7, 1], [7, 1], [4, 4], [4, 4]],
    beat: [[1, 0], [0, 3], [0, 4], [1, 3], [4, 1], [3, 2], [4, 2]],
  });
  assert.deepEqual(seeds(table(ACC_2025)), { seeds: ["A", "B"], steps: ["ABC>A:b", "BC>B:b"] });
  assert.deepEqual(seeds(table(B.RULES.sec)).seeds, ["B", "A"]);
});

test("ACC has no total-wins step, so non-conference games are not enumerated", () => {
  const data = fixture("final-acc-2025.json");
  for (const g of data.games) if (g.week >= 13) Object.assign(g, { completed: false, winner: null, pHome: 0.5 });
  for (const season of [2025, 2026]) {
    const ctx = B.build({ ...data, season });
    assert.ok(ctx.pending.length > 0 && ctx.pending.every((g) => g.conf));
  }
});
