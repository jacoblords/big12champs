// SEC title-game scenarios as published by the press, replayed exhaustively. The SEC doesn't
// publish its own scenarios, so these come from reporters applying its procedure. Only claims
// stated without conditions on other games are checked. For each article: un-play the games
// still ahead when it was written, try every combination of their results, and check every
// finish the claim covers.
//
// Sources:
//   2024, after week 12 (Georgia's SEC season over at 6-2; Texas and Texas A&M 5-1, Alabama 4-2):
//     Saturday Down South, Nov. 18, 2024, "SEC Championship tiebreaker scenarios": Alabama is in
//       "in every scenario that has them beating Oklahoma and Auburn". True whenever winless
//       Mississippi State loses out; the article doesn't consider an upset, and one changes it (below).
//       https://www.saturdaydownsouth.com/sec-football/sec-championship-tiebreaker-scenarios/
//     FanSided, Nov. 23, 2024 (morning of week 13), with Alabama winning out: A&M loses to Texas ->
//       Texas vs Alabama; A&M loses to Auburn but beats Texas -> Georgia vs Alabama. Alabama loses
//       to Oklahoma, A&M loses to Auburn and beats Texas -> Georgia vs A&M. "If Oklahoma beats
//       Alabama", Georgia plays the Texas-A&M winner (not checked: see the test).
//       https://fansided.com/sec-championship-game-scenarios-week-13-auburn-texas-am-alabama-georgia
//   2024, after week 13: CBS Sports, Nov. 24, 2024: Georgia clinched and plays the Texas-A&M winner;
//     Texas would be #1 with a win.
//     https://www.cbssports.com/college-football/news/georgia-clinches-spot-in-sec-championship-game-thanks-to-tiebreakers-will-play-winner-of-texas-vs-texas-a-m
//   2025, after week 12: CBS Sports, Nov. 16, 2025 (the same list ran in SI on Nov. 20):
//     Texas A&M: "Beat Texas OR Auburn beats Alabama, Mississippi State beats Ole Miss".
//     Alabama: "Beat Auburn, Texas beats Texas A&M OR Beat Auburn, Mississippi State beats Ole Miss".
//     Georgia: "Auburn beats Alabama OR Texas beats Texas A&M".
//     Ole Miss: "Beat Mississippi State, Texas beats Texas A&M, Auburn beats Alabama". True except
//       where Ole Miss and A&M are level through step 4 and step 5 (scoring margin) picks A&M (below).
//     https://www.cbssports.com/college-football/news/sec-championship-updates-tiebreakers-texas-a-m-alabama-georgia-ole-miss/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { replayFinal } = require("./helpers.js");

const pairOf = (f) => [...f.pair].sort().join(" vs ");
// Check a claim on every finish it covers; report how many disagree and one example.
function check(finishes, covers, expected, label) {
  const bad = [];
  let n = 0;
  for (const f of finishes) {
    if (!covers(f)) continue;
    n++;
    assert.ok(!f.coin, `${label}: no finish should need a random draw`);
    const want = expected(f);
    if (pairOf(f) !== [...want].sort().join(" vs ")) bad.push(`${pairOf(f)} (expected ${[...want].sort().join(" vs ")})`);
  }
  assert.ok(n > 0, `${label}: the claim covers some finish`);
  assert.equal(bad.length, 0, `${label}: ${bad.length} of ${n} finishes disagree, e.g. ${bad[0]}`);
  return n;
}
const includes = (team) => (f) => f.pair.has(team);
function checkIn(finishes, covers, team, label) {
  const bad = finishes.filter((f) => covers(f) && !f.pair.has(team));
  assert.ok(finishes.some(covers), `${label}: the claim covers some finish`);
  assert.equal(bad.length, 0, `${label}: ${bad.length} finishes without ${team}, e.g. ${bad[0] && pairOf(bad[0])}`);
}

test("2024 after week 13 (CBS): Georgia is in either way and plays the Texas-Texas A&M winner", () => {
  const { finishes } = replayFinal("final-sec-2024.json", [14]);
  assert.equal(finishes.length, 64);
  check(finishes, () => true, (f) => ["UGA", f.beat("TEX", "TA&M") ? "TEX" : "TA&M"], "UGA vs Lone Star winner");
  for (const f of finishes) if (f.beat("TEX", "TA&M")) assert.equal(f.first, "TEX", "Texas at 7-1 is #1");
});

test("2024 after week 12 (SDS, FanSided): Alabama winning out is enough; the A&M results pick its opponent", () => {
  const { finishes } = replayFinal("final-sec-2024.json", [13, 14]);
  assert.equal(finishes.length, 4096);
  const alaOut = (f) => f.wonOut("ALA");
  const msstLosesOut = (f) => !f.won("MSST");
  checkIn(finishes, (f) => alaOut(f) && msstLosesOut(f), "ALA", "SDS: Alabama wins out (Mississippi State loses out)");
  // The exceptions: a Mississippi State upset lifts the opponents' winning percentage of a team
  // that played it (Georgia or Texas A&M; Alabama didn't) past Alabama's in a tie at 6-2
  // (e.g. Georgia .484 to .469), and that team takes the spot.
  const missed = finishes.filter((f) => alaOut(f) && !f.pair.has("ALA"));
  assert.ok(missed.length > 0);
  for (const f of missed) {
    assert.ok(f.won("MSST"), "every exception needs a Mississippi State win");
    assert.ok(f.pair.has("UGA") || f.pair.has("TA&M"));
  }
  // FanSided's branches take Texas beating Kentucky the same day for granted (Texas 7-1 alone on
  // top); with Mississippi State losing out, as above.
  const chalk = (f) => f.beat("TEX", "UK") && msstLosesOut(f);
  check(finishes, (f) => chalk(f) && alaOut(f) && f.beat("TEX", "TA&M"), () => ["TEX", "ALA"], "FanSided: A&M loses to Texas");
  check(finishes, (f) => chalk(f) && alaOut(f) && f.beat("AUB", "TA&M") && f.beat("TA&M", "TEX"), () => ["UGA", "ALA"], "FanSided: A&M loses at Auburn, beats Texas");
  // This branch is what actually happened through week 13 (CBS, Nov. 24: an A&M win means A&M vs
  // Georgia). One finish the articles didn't consider breaks it: Ole Miss beats Florida and
  // Vanderbilt upsets LSU and Tennessee, so Ole Miss joins a four-way tie at 6-2, and Texas and
  // Georgia tie for the best opponents' winning percentage (.438) ahead of A&M (.422). Both are in.
  const amPath = (f) => chalk(f) && f.beat("OU", "ALA") && f.beat("AUB", "TA&M") && f.beat("TA&M", "TEX");
  const { ctx: ctx24 } = replayFinal("final-sec-2024.json", [13, 14]);
  const odd = finishes.filter((f) => amPath(f) && !f.pair.has("TA&M"));
  assert.equal(odd.length, 1);
  assert.ok(odd[0].beat("MISS", "FLA") && odd[0].beat("VAN", "LSU") && odd[0].beat("VAN", "TENN"));
  const oddTrace = B.explain(ctx24, odd[0].mask).trace[0];
  assert.equal(oddTrace.step, "d");
  assert.deepEqual(oddTrace.cut.map((t) => ctx24.teams[t].abbr).sort(), ["MISS", "TA&M"]);
  check(finishes, (f) => amPath(f) && !odd.includes(f), () => ["UGA", "TA&M"], "FanSided: Alabama and A&M both lose a week-13 game, A&M beats Texas");
  // Not checked: FanSided's "If Oklahoma beats Alabama, Georgia plays the Texas-A&M winner" with
  // nothing else assumed. It overlooks Ole Miss, which could still finish 6-2 and beat Georgia
  // head-to-head, and a Georgia/Tennessee/A&M tie at 6-2 that A&M takes on opponents' win %.
  // Pinned here so the counterexample stays visible:
  const olemiss = finishes.filter((f) => f.beat("OU", "ALA") && f.wonOut("MISS") && f.wonOut("TEX") && f.beat("VAN", "TENN") && f.beat("AUB", "TA&M"));
  assert.ok(olemiss.length > 0);
  for (const f of olemiss) assert.deepEqual([...f.pair].sort(), ["MISS", "TEX"], "Ole Miss beat Georgia");
});

test("2025 after week 12 (CBS): every unconditional path in the published list", () => {
  const { finishes } = replayFinal("final-sec-2025.json", [13, 14]);
  assert.equal(finishes.length, 1024);
  checkIn(finishes, (f) => f.beat("TA&M", "TEX"), "TA&M", "A&M beats Texas");
  checkIn(finishes, (f) => f.beat("AUB", "ALA") && f.beat("MSST", "MISS"), "TA&M", "Auburn and Mississippi State win");
  checkIn(finishes, (f) => f.beat("ALA", "AUB") && f.beat("TEX", "TA&M"), "ALA", "Alabama and Texas win");
  checkIn(finishes, (f) => f.beat("ALA", "AUB") && f.beat("MSST", "MISS"), "ALA", "Alabama and Mississippi State win");
  checkIn(finishes, (f) => f.beat("AUB", "ALA"), "UGA", "Auburn beats Alabama");
  checkIn(finishes, (f) => f.beat("TEX", "TA&M"), "UGA", "Texas beats A&M");
  const missPath = (f) => f.beat("MISS", "MSST") && f.beat("TEX", "TA&M") && f.beat("AUB", "ALA");
  const { ctx } = replayFinal("final-sec-2025.json", []);
  const missed = finishes.filter((f) => missPath(f) && !f.pair.has("MISS"));
  assert.ok(missed.length > 0 && missed.length < finishes.filter(missPath).length / 10);
  for (const f of missed) {
    // Ole Miss, Georgia and A&M at 7-1; Georgia in on opponents' win %; then Ole Miss and A&M are
    // level through step 4 and A&M has the better capped scoring margin.
    const replayed = replayFinal("final-sec-2025.json", [13, 14]);
    const ex = B.explain(replayed.ctx, f.mask);
    const last = ex.trace.find((t) => t.tied.length === 2 && t.tied.every((x) => ["MISS", "TA&M"].includes(replayed.ctx.teams[x].abbr)));
    assert.ok(last && last.step === "f", "decided on scoring margin");
    assert.equal(replayed.ctx.teams[last.winner].abbr, "TA&M");
  }
  checkIn(finishes, (f) => missPath(f) && !missed.includes(f), "MISS", "Ole Miss, Texas and Auburn win (unless it comes down to scoring margin)");
  assert.ok(ctx);
  // and nobody else ever gets in
  for (const f of finishes) for (const t of f.pair) assert.ok(["TA&M", "ALA", "UGA", "MISS"].includes(t), t);
});
