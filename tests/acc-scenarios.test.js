// ACC title-game scenarios as published, replayed exhaustively under the 2024-25 procedure they
// were written for. The ACC published its own list once (2025's final week); the rest come from
// the press. For each source: un-play the weeks still ahead when it was written, try every
// combination of results, and check every finish the claim covers.
//
// Sources:
//   2024, after week 12 (SMU 6-0, Clemson 7-1 and done, Miami 5-1):
//     CBS Sports, Nov. 22, 2024: SMU is in with a win over Virginia, and "just needs to win one of
//       its last two"; "Miami would be eliminated ... if it loses to Wake Forest and SMU beats
//       Virginia"; Clemson needs "Miami to lose one of its last two games or SMU to lose twice".
//       https://www.cbssports.com/college-football/news/conference-championship-game-scenarios-how-smu-indiana-can-punch-their-tickets-in-week-13/
//     theACC.com, Nov. 23, 2024: SMU "clinched a spot ... with their 33-7 win at Virginia".
//       https://theacc.com/news/2024/11/23/smu-clinches-spot-in-20th-acc-football-championship-game.aspx
//   2024, after week 13: FanSided, Nov. 23, 2024: SMU is in; "Miami wins next week, and they're in
//     ... If they lose to Syracuse next weekend, Clemson takes the last spot."
//     https://fansided.com/acc-championship-game-scenarios-smu-miami-clemson
//     The Island Packet (via Yahoo), Nov. 20, 2024, quoting an ACC spokesman to The State on the
//       three-way 7-1 tie: SMU and Miami advance on common opponents.
//       https://sports.yahoo.com/articles/updated-acc-championship-game-scenarios-113000298.html
//   2025, after week 12: Sports Illustrated, Nov. 19, 2025, "ACC Championship Game Scenarios
//     Entering Week 13". Georgia Tech, Virginia, Pitt and SMU hold. Miami's path and Pitt's second
//     one don't, everywhere (below).
//     https://www.si.com/college-football/acc-championship-game-scenarios-entering-week-13
//   2025, after week 13: theACC.com, Nov. 24, 2025, "2025 ACC Football Championship Game
//     Tiebreakers": every clinching combination for six teams, some ending in "Finish higher than
//     X in SportSource Analytics ranking".
//     https://theacc.com/news/2025/11/24/2025-acc-football-championship-game-tiebreakers.aspx
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { replayFinal, sampleSeason } = require("./helpers.js");

const pairOf = (f) => [...f.pair].sort().join(" vs ");
function checkIn(finishes, covers, team, label) {
  const covered = finishes.filter(covers);
  assert.ok(covered.length > 0, `${label}: the claim covers some finish`);
  for (const f of covered) assert.ok(!f.coin, `${label}: no finish should need a random draw`);
  const bad = covered.filter((f) => !f.pair.has(team));
  assert.equal(bad.length, 0, `${label}: ${bad.length} of ${covered.length} finishes without ${team}, e.g. ${bad[0] && pairOf(bad[0])}`);
  return covered.length;
}
const stepsOf = (ctx, f) => B.explain(ctx, f.mask).trace.map((t) => ({ ...t, tied: t.tied.map((i) => ctx.teams[i].abbr), winner: t.winner == null ? null : ctx.teams[t.winner].abbr }));

test("2024 after week 12 (CBS, ACC): SMU in with one more win; Miami's and Clemson's paths", () => {
  const { finishes, ctx } = replayFinal("final-acc-2024.json", [13, 14]);
  assert.equal(ctx.rules, B.RULES.acc.before.rules);
  assert.equal(finishes.length, 8192);
  checkIn(finishes, (f) => f.beat("SMU", "UVA"), "SMU", "ACC: SMU clinched by beating Virginia");
  checkIn(finishes, (f) => f.beat("SMU", "UVA") || f.beat("SMU", "CAL"), "SMU", "SMU wins one of two");
  for (const f of finishes) {
    if (f.beat("WAKE", "MIA") && f.beat("SMU", "UVA")) assert.ok(!f.pair.has("MIA"), "Miami eliminated");
    if (f.pair.has("CLEM")) assert.ok(f.lost("MIA") || (f.lost("SMU", 13) && f.lost("SMU", 14)), "Clemson needs help");
  }
  // An ACC spokesman, to The State (via the Island Packet, Nov. 20, 2024): in a three-way tie at
  // 7-1, "SMU and Miami are both 2-0 against Florida State and Louisville, while Clemson is 1-1",
  // so Clemson would lose it and "SMU and Miami would advance".
  checkIn(finishes, (f) => f.wonOut("MIA") && f.losses("SMU") === 1, "SMU", "spokesman: three-way 7-1");
  checkIn(finishes, (f) => f.wonOut("MIA") && f.losses("SMU") === 1, "MIA", "spokesman: three-way 7-1");
  for (const f of finishes.filter((f) => f.wonOut("MIA") && f.losses("SMU") === 1)) {
    const cut = stepsOf(ctx, f).find((t) => t.tied.length === 3);
    assert.equal(cut.step, "b", "decided on common opponents");
  }
});

test("2024 after week 13 (FanSided): SMU is in, and Miami-Syracuse decides Miami or Clemson", () => {
  const { finishes } = replayFinal("final-acc-2024.json", [14]);
  assert.equal(finishes.length, 64);
  for (const f of finishes) {
    assert.ok(!f.coin);
    assert.equal(pairOf(f), ["SMU", f.beat("MIA", "SYR") ? "MIA" : "CLEM"].sort().join(" vs "));
  }
});

test("2025 after week 12 (SI): Georgia Tech, Virginia, Pitt and SMU paths", () => {
  const { finishes } = replayFinal("final-acc-2025.json", [13, 14]);
  assert.equal(finishes.length, 4096);
  checkIn(finishes, (f) => f.beat("GT", "PITT"), "GT", "Georgia Tech beats Pitt");
  checkIn(finishes, (f) => f.beat("UVA", "VT") && f.lost("SMU") && f.lost("PITT"), "UVA",
    "Virginia beats Virginia Tech, SMU loses to Louisville or Cal, Pitt loses to Georgia Tech or Miami");
  checkIn(finishes, (f) => f.wonOut("PITT") && f.lost("SMU") && f.beat("UVA", "VT"), "PITT",
    "Pitt beats Georgia Tech and Miami, SMU loses to Louisville or Cal, Virginia beats Virginia Tech");
  checkIn(finishes, (f) => f.wonOut("SMU") && f.beat("VT", "UVA") && f.beat("PITT", "GT") && f.beat("MIA", "PITT"), "SMU",
    "SMU beats Louisville and Cal, Virginia Tech beats Virginia, Pitt beats Georgia Tech, Miami beats Pitt");
});

test("2025 after week 12 (SI): two paths the article got wrong, pinned", () => {
  const { finishes, ctx } = replayFinal("final-acc-2025.json", [13, 14]);
  // "Pittsburgh can also make the ACC title game ... if SMU beats Louisville and Cal and then
  // Virginia beats Virginia Tech." That's a three-way tie at 7-1 that never reaches Pitt's head-to-
  // head win: Virginia and SMU went 2-0 against common opponents Louisville and Stanford, Pitt 1-1.
  const also = finishes.filter((f) => f.wonOut("PITT") && f.wonOut("SMU") && f.beat("UVA", "VT"));
  assert.equal(also.length, 128);
  for (const f of also) {
    assert.equal(pairOf(f), "SMU vs UVA");
    const [first] = stepsOf(ctx, f);
    assert.deepEqual([first.step, first.tied.sort().join()], ["b", "PITT,SMU,UVA"]);
  }
  // Miami: "Beats Virginia Tech and Pitt; Virginia beats Virginia Tech; Pitt beats Georgia Tech;
  // Duke beats North Carolina; SMU beats Louisville; Cal beats SMU; Wake Forest beats Duke", or
  // the same with Louisville beating SMU and SMU beating Cal. That's a four-way tie at 6-2 (Miami,
  // SMU, Georgia Tech, Pitt) decided on opponents' winning percentage, and four games the article
  // doesn't mention move it: NC State-Florida State, Stanford-Cal, NC State-North Carolina and
  // Syracuse-Boston College. Where they go against Miami, SMU or Georgia Tech gets in. The ACC's
  // own list a week later (below) names the last two.
  const mia = (f) => f.beat("MIA", "VT") && f.beat("MIA", "PITT") && f.beat("UVA", "VT") && f.beat("PITT", "GT") &&
    f.beat("DUKE", "UNC") && f.beat("WAKE", "DUKE") &&
    ((f.beat("SMU", "LOU") && f.beat("CAL", "SMU")) || (f.beat("LOU", "SMU") && f.beat("SMU", "CAL")));
  const covered = finishes.filter(mia);
  assert.equal(covered.length, 32);
  assert.equal(covered.filter((f) => f.pair.has("MIA")).length, 13);
  for (const f of covered.filter((x) => !x.pair.has("MIA"))) {
    const [first] = stepsOf(ctx, f);
    assert.equal(first.step, "d");
    assert.deepEqual(first.tied.sort(), ["GT", "MIA", "PITT", "SMU"]);
    assert.ok(["SMU vs UVA", "GT vs UVA"].includes(pairOf(f)));
  }
  checkIn(finishes, (f) => mia(f) && f.beat("NCSU", "FSU") && f.beat("STAN", "CAL") && f.beat("NCSU", "UNC") && f.beat("SYR", "BC"), "MIA",
    "SI's Miami path, with the other four games as they went in week 13 and as the ACC's list required in week 14");
});

test("2025 after week 13 (ACC): every combination in the conference's own list", () => {
  const { finishes, ctx } = replayFinal("final-acc-2025.json", [14]);
  assert.equal(finishes.length, 64);
  const W = (f, t) => f.won(t, 14), L = (f, t) => f.lost(t, 14);
  // [team, clinching combinations, combinations that also need a better SportSource ranking than these teams]
  const LIST = [
    ["DUKE", [
      (f) => W(f, "DUKE") && L(f, "PITT") && L(f, "SMU"),
      (f) => W(f, "DUKE") && L(f, "PITT") && L(f, "SMU") && L(f, "UVA"),
      (f) => W(f, "DUKE") && L(f, "PITT") && L(f, "UVA") && W(f, "UNC"),
    ], [
      [(f) => W(f, "DUKE") && L(f, "PITT") && L(f, "UVA") && W(f, "NCSU"), ["MIA"]],
    ]],
    ["GT", [
      (f) => W(f, "PITT") && L(f, "UVA") && L(f, "SMU"),
      (f) => W(f, "MIA") && L(f, "SMU") && L(f, "DUKE") && L(f, "UVA") && W(f, "NCSU"),
    ], [
      [(f) => W(f, "MIA") && L(f, "SMU") && L(f, "DUKE") && L(f, "UVA") && W(f, "UNC") && W(f, "BC"), ["MIA", "SMU"]],
      [(f) => W(f, "MIA") && L(f, "SMU") && L(f, "DUKE") && W(f, "UVA") && W(f, "NCSU") && W(f, "BC"), ["MIA", "SMU"]],
    ]],
    ["MIA", [
      (f) => W(f, "MIA") && L(f, "UVA") && L(f, "DUKE") && W(f, "SMU"),
      (f) => W(f, "MIA") && L(f, "SMU") && L(f, "DUKE") && L(f, "UVA") && W(f, "NCSU"),
      (f) => W(f, "MIA") && L(f, "SMU") && L(f, "DUKE") && L(f, "UVA") && W(f, "UNC") && W(f, "SYR"),
      (f) => W(f, "MIA") && L(f, "SMU") && L(f, "DUKE") && W(f, "UVA") && W(f, "NCSU") && W(f, "SYR"),
      (f) => W(f, "MIA") && L(f, "SMU") && W(f, "DUKE") && L(f, "UVA") && W(f, "NCSU"),
    ], [
      [(f) => W(f, "MIA") && L(f, "SMU") && L(f, "DUKE") && L(f, "UVA") && W(f, "UNC") && W(f, "BC"), ["GT", "SMU"]],
      [(f) => W(f, "MIA") && L(f, "SMU") && L(f, "DUKE") && W(f, "UVA") && W(f, "NCSU") && W(f, "BC"), ["GT", "SMU"]],
      [(f) => W(f, "MIA") && W(f, "SMU") && W(f, "DUKE") && L(f, "UVA") && W(f, "NCSU"), ["DUKE"]],
    ]],
    ["PITT", [(f) => W(f, "PITT") && L(f, "UVA"), (f) => W(f, "PITT") && L(f, "SMU")], []],
    ["SMU", [
      (f) => W(f, "SMU"),
      (f) => L(f, "PITT") && L(f, "DUKE") && W(f, "UVA") && W(f, "UNC"),
    ], [
      [(f) => L(f, "PITT") && L(f, "DUKE") && W(f, "UVA") && W(f, "NCSU") && W(f, "BC"), ["GT", "MIA"]],
      [(f) => L(f, "PITT") && L(f, "DUKE") && L(f, "UVA") && W(f, "UNC") && W(f, "BC"), ["GT", "MIA"]],
    ]],
    ["UVA", [(f) => W(f, "UVA"), (f) => L(f, "SMU") && L(f, "PITT") && W(f, "UNC")], []],
  ];
  for (const [team, sure, ranked] of LIST) {
    sure.forEach((c, i) => checkIn(finishes, c, team, `${team} combination ${i + 1}`));
    // A ranking combination: where no sure one already settles it, the ranking step decides
    // between this team and the ones named (FPI standing in, so who wins it isn't checked).
    for (const [c, rivals] of ranked) {
      const open = finishes.filter((f) => c(f) && !sure.some((s) => s(f)));
      assert.ok(open.length > 0, `${team}: ranking combination covers an open finish`);
      for (const f of open) {
        const byRating = stepsOf(ctx, f).filter((t) => t.step === "f" && t.tied.includes(team));
        assert.ok(byRating.length, `${team}: the ranking decides`);
        assert.ok(rivals.every((r) => byRating.some((t) => t.tied.includes(r))), `${team} vs ${rivals}`);
      }
    }
    // and nobody gets in another way
    const any = [...sure, ...ranked.map(([c]) => c)];
    for (const f of finishes) if (f.pair.has(team)) assert.ok(any.some((c) => c(f)), `${team} in by an unlisted path: ${pairOf(f)}`);
  }
  for (const f of finishes) assert.ok(!f.coin);
});

// ---- 2026, in season, under the new policy (sampled: 22 games left is too many to try them all) ----
// Sources, after week 10 (standings Miami 6-0, Wake Forest 5-1, Louisville 5-2, SMU 5-2, Duke 4-2,
// Clemson 4-2; Clemson plays eight conference games, the others nine):
//   A to Z Sports (via Yardbarker), Nov. 10, 2026: "if Clemson, Wake, and Miami all end up with
//     two ACC losses, Miami still gets the nod by having beaten them both."
//     https://www.yardbarker.com/college_football/articles/miami_hurricanes_could_snap_a_9_year_drought_on_saturday_and_it_will_be_their_last_chance_ever_to_claim_a_program_first/s1_17313_44542732
//   The Clemson Insider, Nov. 9, 2026, "Clemson's path to the ACC Championship Game": Clemson must
//     beat Duke, needs Duke to beat Wake Forest, and needs "Louisville to lose just one game".
//     https://www.theclemsoninsider.com/2026/11/09/clemsons-path-to-the-acc-championship-game/
test("2026 after week 10 (A to Z, Clemson Insider): Miami's head-to-head wins, and Clemson's path", () => {
  const { finishes, ctx } = sampleSeason("acc-season-2026-11-09.json", 20000);
  assert.equal(ctx.rules, B.RULES.acc);
  const allTwo = (f) => ["MIA", "WAKE", "CLEM"].every((t) => f.losses(t) === 2);
  checkIn(finishes, allTwo, "MIA", "A to Z: Miami, Wake and Clemson all with two losses");
  const clemIn = finishes.filter((f) => f.pair.has("CLEM"));
  assert.ok(clemIn.length > 0, "Clemson has a path");
  for (const f of clemIn) {
    assert.ok(f.beat("CLEM", "DUKE"), "Clemson Insider: Clemson must beat Duke");
    assert.ok(f.beat("DUKE", "WAKE"), "Clemson Insider: Clemson needs Duke to beat Wake Forest");
    assert.ok(f.lost("LOU"), "Clemson Insider: Clemson needs a Louisville loss");
  }
});
