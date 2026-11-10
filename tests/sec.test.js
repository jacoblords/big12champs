// SEC tiebreakers: the league's real title games, its published 2025 final-week scenario, and
// the two places its procedure differs from the Big 12's. Run: node --test tests/
//
// Sources:
//   Procedure (2024-, 16 teams, no divisions): "SEC announces football tie-breaking process",
//     https://www.secsports.com/news/2024/08/sec-announces-football-tie-breaking-process
//     1 head-to-head, 2 common opponents, 3 highest-placed common opponent down the standings,
//     4 cumulative conference win % of conference opponents, 5 capped relative total scoring
//     margin (SportSource), 6 random draw. No total-wins step. Two teams tied for first both go
//     and "go through a two-team tiebreaker ... deciding home/away designation".
//   Title games (ESPN, home team = #1 seed): 2024 Georgia at Texas; 2025 Georgia at Alabama.
//   2025 final week: Georgia clinched once Texas beat Texas A&M; "If Alabama beats Auburn,
//     Alabama qualifies ... holding the tiebreaker in opponent winning percentage"; Ole Miss's
//     "only path ... is a loss by Alabama" (CBS Sports and The Sportscast, Nov. 28-29, 2025).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { standingsTable, seeds } = require("./helpers.js");

const fixture = (name) => JSON.parse(JSON.stringify(require(`./fixtures/${name}`)));
const SEC = B.RULES.sec;

function finalSeeds(file) {
  const ctx = B.build(fixture(file));
  assert.equal(ctx.pending.length, 0);
  const ex = B.explain(ctx, 0);
  const ab = (i) => ctx.teams[i].abbr;
  return { ctx, ex, ab, seeds: ex.seeds.map(ab) };
}

test("SEC data is read with SEC rules", () => {
  const ctx = B.build(fixture("final-sec-2025.json"));
  assert.equal(ctx.rules, SEC);
  assert.equal(B.build(fixture("final-2025.json")).rules, B.RULES.big12, "data without a league is Big 12");
});

test("2024: Texas alone at 7-1 is #1, Georgia beats Tennessee head-to-head for #2", () => {
  const { ex, ab, seeds: s } = finalSeeds("final-sec-2024.json");
  assert.deepEqual(s, ["TEX", "UGA"]);
  assert.equal(ex.trace.length, 1);
  const [tb] = ex.trace;
  assert.deepEqual(tb.tied.map(ab).sort(), ["TENN", "UGA"]);
  assert.equal(tb.step, "a");
  assert.equal(ab(tb.winner), "UGA");
});

test("2025: four-way tie at 7-1, Georgia and Alabama in, then Alabama #1 on head-to-head", () => {
  const { ex, ab, seeds: s, ctx } = finalSeeds("final-sec-2025.json");
  assert.deepEqual(s, ["ALA", "UGA"]);
  const top = ex.groups[0].map(ab).sort();
  assert.deepEqual(top, ["ALA", "MISS", "TA&M", "UGA"]);
  for (const t of ex.groups[0]) assert.equal(`${ex.st.CW[t]}-${ex.st.CL[t]}`, "7-1");
  // the qualifying decisions are marked as spots, not seeds, and they run on opponents' win %
  const spots = ex.trace.filter((t) => t.spot);
  assert.ok(spots.length >= 1);
  assert.ok(spots.some((t) => t.step === "d"), "opponent winning percentage decides who gets in");
  // the last decision seeds the two qualifiers with the two-team steps: Alabama beat Georgia
  const last = ex.trace[ex.trace.length - 1];
  assert.ok(!last.spot);
  assert.deepEqual(last.tied.map(ab).sort(), ["ALA", "UGA"]);
  assert.equal(last.step, "a");
  assert.equal(ab(last.winner), "ALA");
  assert.ok(ctx.teams.length === 16);
});

test("2025 final week, as published: Georgia in either way; the Iron Bowl decides Alabama or Ole Miss", () => {
  // Un-play the week-14 SEC games. Friday's results were in when the scenarios were published:
  // Texas beat Texas A&M and Ole Miss beat Mississippi State.
  const data = fixture("final-sec-2025.json");
  const ctx0 = B.build(data);
  const id = (a) => ctx0.teams.find((t) => t.abbr === a).id;
  const fixed = new Set();
  for (const g of data.games) {
    if (g.week !== 14 || !g.conf) continue;
    const teams = [g.home, g.away];
    if (teams.includes(id("TA&M")) || teams.includes(id("MISS"))) { fixed.add(g.id); continue; }
    Object.assign(g, { completed: false, winner: null, pHome: 0.5 });
  }
  const ctx = B.build(data);
  const ab = (i) => ctx.teams[i].abbr;
  const iron = ctx.pending.findIndex((g) => [ab(g.h), ab(g.a)].sort().join() === "ALA,AUB");
  assert.ok(iron >= 0, "the Iron Bowl is un-played");
  assert.ok(ctx.pending.length <= 12);
  for (let m = 0; m < 2 ** ctx.pending.length; m++) {
    const out = Uint8Array.from(ctx.pending, (g, k) => (m >>> k) & 1);
    const s = B.titleGame(B.standings(ctx, out), () => { throw new Error("no random draw expected"); }).map(ab);
    const g = ctx.pending[iron];
    const alaWon = ab(out[iron] ? g.h : g.a) === "ALA";
    assert.deepEqual(new Set(s), new Set(["UGA", alaWon ? "ALA" : "MISS"]), `finish ${m}`);
  }
});

test("no total-wins step: a tie level through step 4 goes to step 5 (the rating stand-in)", () => {
  const base = { records: [[8, 0], [6, 2], [6, 2]], total: { 1: 10, 2: 9 }, fpi: { 1: 1, 2: 5 } };
  assert.deepEqual(seeds(standingsTable(3, base)).steps, ["BC>B:e"], "Big 12 stops at total wins");
  assert.deepEqual(seeds(standingsTable(3, { ...base, rules: SEC })).steps, ["BC>C:f"]);
});

test("three tied for first: the two who get in are seeded by the two-team steps", () => {
  // B beat A; C played neither. Common opponents D and E: A 2-0, B 1-1, C 0-2. A gets in at
  // step 2. B and C start over: B is 1-1 against D and E, C 0-2, so B gets in. Big 12: A is #1.
  // SEC: A and B are then seeded head to head, and B beat A.
  const table = (rules) => standingsTable(5, {
    rules,
    records: [[7, 1], [7, 1], [7, 1], [4, 4], [4, 4]],
    beat: [[1, 0], [0, 3], [0, 4], [1, 3], [4, 1], [3, 2], [4, 2]],
  });
  assert.deepEqual(seeds(table()), { seeds: ["A", "B"], steps: ["ABC>A:b", "BC>B:b"] });
  const sec = seeds(table(SEC));
  assert.deepEqual(sec, { seeds: ["B", "A"], steps: ["ABC>A:b", "BC>B:b", "AB>B:a"] });
});

test("two tied for first: both go and head-to-head seeds them, same as the Big 12", () => {
  const r = seeds(standingsTable(3, { rules: SEC, records: [[7, 1], [7, 1], [6, 2]], beat: [[1, 0]] }));
  assert.deepEqual(r, { seeds: ["B", "A"], steps: ["AB>B:a"] });
});

test("non-conference games can't change an SEC tiebreak, so they are not enumerated", () => {
  const data = fixture("final-sec-2025.json");
  for (const g of data.games) if (g.week >= 13) Object.assign(g, { completed: false, winner: null, pHome: 0.5 });
  const ctx = B.build(data);
  assert.ok(ctx.pending.length > 0);
  assert.ok(ctx.pending.every((g) => g.conf), "only conference games are left to play");
  const asBig12 = B.build({ ...data, league: "big12" });
  assert.ok(asBig12.pending.some((g) => !g.conf), "the Big 12 keeps them for total wins");
});

test("SEC step labels are the league's own numbers", () => {
  assert.deepEqual(SEC.steps, ["a", "b", "c", "d", "f", "g"]);
  assert.deepEqual(SEC.steps.map((s) => SEC.label[s]), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(B.RULES.big12.steps.map((s) => B.RULES.big12.label[s]).join(""), "abcdefg");
});
