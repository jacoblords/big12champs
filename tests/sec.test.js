// SEC tiebreakers: the league's real title games, its published 2025 final-week scenario, and
// the two places its procedure differs from the Big 12's. Run: node --test tests/
//
// Sources:
//   Procedure: "Southeastern Conference Official Football Tiebreakers" (Final 10.29.24), linked from
//     https://www.secsports.com/fbtiebreaker and unchanged through the 2025 season (Wayback snapshots
//     2024-11 to 2025-12). Steps A-F: head-to-head, common opponents, highest-placed common
//     opponent down the standings, opponents' winning percentage, capped relative total scoring
//     margin (Appendix A), random draw. No total-wins step. Two teams tied for first both go and
//     "progress through the Two-Team tiebreaker procedures" for home/away. Its Appendix B worked
//     examples are replayed below.
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

// ---- The SEC's own worked examples ----
// "Southeastern Conference Official Football Tiebreakers" (Final 10.29.24), Appendix B, linked from
// https://www.secsports.com/fbtiebreaker and unchanged through the 2025 season:
// https://storage.googleapis.com/secsports-prod/upload/2024/10/29/f6fc7cd9-3031-4357-8754-80bfa4b9c4c0.pdf
// Each example gives only the facts that matter; the tables below add opponents so that the
// earlier steps come out even, the way the example implies.
const sec = (opts) => seeds(standingsTable(opts.records.length, { rules: SEC, ...opts }));

test("SEC example, two-team tie for 2nd, step C #1: a tied pair of opponents is split by head-to-head first", () => {
  // A 7-1; B and C 6-2; D and E 5-3, D beat E. B played A, C didn't. Both played D and E and went
  // 1-1 against them, so steps B and the combined D/E record are even. D is ranked above E, so
  // only D counts: B beat D, C lost to D. B goes. (Counting D and E together would not separate them.)
  const r = sec({
    records: [[7, 1], [6, 2], [6, 2], [5, 3], [5, 3]],
    beat: [[0, 1], [3, 4], [1, 3], [4, 1], [3, 2], [2, 4]],
  });
  assert.deepEqual(r, { seeds: ["A", "B"], steps: ["BC>B:c"] });
});

test("SEC example, two-team tie for 2nd, step C #3: an unbroken tie among opponents is combined", () => {
  // D and E 5-3 didn't play each other. B 2-0 against them, C 0-2. F and G (4-4) even it out at
  // step B: B lost to both, C beat both.
  const r = sec({
    records: [[7, 1], [6, 2], [6, 2], [5, 3], [5, 3], [4, 4], [4, 4]],
    beat: [[0, 1], [1, 3], [1, 4], [3, 2], [4, 2], [5, 1], [6, 1], [2, 5], [2, 6]],
  });
  assert.deepEqual(r, { seeds: ["A", "B"], steps: ["BC>B:c"] });
});

test("SEC example, two-team tie for 2nd, step C #4: only common opponents count inside a tied group", () => {
  // C didn't play E, so only D counts: B beat D, C lost to D. F (4-4) evens out step B.
  const r = sec({
    records: [[7, 1], [6, 2], [6, 2], [5, 3], [5, 3], [4, 4]],
    beat: [[0, 1], [1, 3], [4, 1], [3, 2], [5, 1], [2, 5]],
  });
  assert.deepEqual(r, { seeds: ["A", "B"], steps: ["BC>B:c"] });
});

test("SEC example, 3+ tie for 1st, head-to-head #1: a team that beat both others is in", () => {
  // A beat B and C; B and C didn't play. B and C then go to the two-team steps: common opponent D.
  const r = sec({ records: [[6, 2], [6, 2], [6, 2], [4, 4]], beat: [[0, 1], [0, 2], [1, 3], [3, 2]] });
  assert.deepEqual(r.steps.slice(0, 2), ["ABC>A:a", "BC>B:b"]);
  assert.deepEqual(new Set(r.seeds), new Set(["A", "B"]));
});

test("SEC example, 3+ tie for 1st, head-to-head #2: a team that lost to both others is out, the other two go", () => {
  // A lost to B and C; B and C didn't play. B and C are both in and seeded by the two-team steps
  // (here, common opponent D). The Big 12 keeps A in: losing to everyone doesn't eliminate there.
  const opts = { records: [[6, 2], [6, 2], [6, 2], [4, 4]], beat: [[1, 0], [2, 0], [2, 3], [3, 1], [0, 3]] };
  const r = sec(opts);
  assert.equal(r.steps[0], "ABC-A:a");
  assert.deepEqual(r.seeds, ["C", "B"]);
  assert.notEqual(seeds(standingsTable(4, opts)).steps[0], "ABC-A:a");
});

test("SEC example, 3+ tie for 1st, head-to-head #3: no round robin, the team that lost to all three is out", () => {
  // A, B, C, D 5-3. D lost to A, B and C; A, B and C didn't all play each other (A beat B only).
  const r = sec({ records: [[5, 3], [5, 3], [5, 3], [5, 3]], beat: [[0, 3], [1, 3], [2, 3], [0, 1]], rating: { 0: 3, 1: 2, 2: 1 } });
  assert.equal(r.steps[0], "ABCD-D:a");
  assert.ok(!r.seeds.includes("D"));
});

test("SEC example, 3+ tie for 1st, common opponents A: a team behind is out and the rest start over", () => {
  // Four-way tie, one common opponent E: A, B, C beat it, D lost. D is out; A, B, C start over.
  const r = sec({
    records: [[6, 2], [6, 2], [6, 2], [6, 2], [3, 5]],
    beat: [[0, 4], [1, 4], [2, 4], [4, 3], [0, 1], [1, 2]],
    rating: { 0: 3, 1: 2, 2: 1 },
  });
  assert.equal(r.steps[0], "ABCD-D:b");
  assert.ok(!r.seeds.includes("D"));
});

test("SEC example, 3+ tie for 1st, common opponents B: a clear leader is in, everyone else goes for 2nd", () => {
  // Two common opponents E, F: A 2-0, B 1-1, C 1-1, D 0-2. A is in; B, C and D (D too) go for 2nd.
  const r = sec({
    records: [[6, 2], [6, 2], [6, 2], [6, 2], [3, 5], [3, 5]],
    beat: [[0, 4], [0, 5], [1, 4], [5, 1], [2, 4], [5, 2], [4, 3], [5, 3]],
    rating: { 1: 2, 3: 9 },
  });
  assert.equal(r.steps[0], "ABCD>A:b");
  assert.equal(r.steps[1].split(">")[0].split(":")[0].replace(/-.*/, ""), "BCD", "D is still in the race for 2nd");
});

test("SEC example, 3+ tie for 1st, common opponents #2: two level at the top are both in", () => {
  const r = sec({
    records: [[6, 2], [6, 2], [6, 2], [3, 5], [3, 5]],
    beat: [[0, 3], [0, 4], [1, 3], [1, 4], [2, 3], [4, 2], [1, 0]],
  });
  assert.equal(r.steps[0], "ABC-C:b");
  assert.deepEqual(r.seeds, ["B", "A"], "then seeded head to head: B beat A");
});

test("SEC capped relative scoring margin: the Appendix A example, and its 200% cap", () => {
  // Team A beats Team B 31-28. B averaged 24 scored and 21 allowed: A's game margin is
  // 31/21 - 28/24 = +30.95% (the PDF rounds each part first and shows +30.9%). Scoring more
  // than 2x what B allows is capped at 200%.
  assert.ok(Math.abs(B.gameMargin(31, 28, { scored: 24, allowed: 21 }) - 30.95) < 0.01);
  assert.equal(B.gameMargin(50, 28, { scored: 24, allowed: 21 }).toFixed(1), (200 - 28 / 24 * 100).toFixed(1));
});

test("SEC step 5 uses the capped scoring margin from real scores, averaged over conference games", () => {
  const ctx = B.build(fixture("final-sec-2025.json"));
  const st = B.standings(ctx, new Uint8Array(0));
  const id = (a) => ctx.teams.findIndex((t) => t.abbr === a);
  // every team has a margin; better teams tend to have bigger ones
  for (let t = 0; t < ctx.N; t++) assert.ok(Number.isFinite(st.rating[t]), ctx.teams[t].abbr);
  assert.ok(st.rating[id("TA&M")] > st.rating[id("ARK")]);
  // the Big 12 keeps its rating stand-in (FPI)
  const b12 = B.build(fixture("final-2025.json"));
  assert.equal(B.standings(b12, new Uint8Array(0)).rating[0], b12.teams[0].fpi);
});
