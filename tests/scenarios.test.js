// The Big 12's own published title-game scenarios, replayed exhaustively.
// For each document: un-play the weeks it covers, try every combination of those results, and
// check the engine's title-game pair against what the conference said.
//
// Sources (official):
//   2024 week 14: "Dr Pepper Big 12 Football Championship Tiebreakers Update/Central"
//     https://big12sports.com/news/2024/11/24/2024-dr-pepper-big-12-football-championship-tiebreakers-update.aspx
//   2025 weeks 13-14: "2025 Edward Jones Big 12 Football Championship Tiebreaker Central"
//     https://big12sports.com/sports/2025/10/30/football-tiebreaker-central.aspx (Wayback revisions
//     of 2025-11-21 for week 13 and 2025-11-28 for the final week-14 text)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { replayFinal } = require("./helpers.js");

const replay = (season, weeks) => replayFinal(`final-${season}.json`, weeks);
const pairOf = (f) => [...f.pair].sort().join(" vs ");

test("2024 final week: every published 7-2 tie scenario", () => {
  // Entering week 14: ASU, BYU, Colorado, Iowa State 6-2. 8 games left -> 256 finishes.
  const { finishes } = replay(2024, [14]);
  assert.equal(finishes.length, 256);
  let checked = 0;
  for (const f of finishes) {
    assert.ok(!f.coin, "no finish should need a coin toss");
    const at72 = ["ASU", "BYU", "COLO", "ISU"].filter((t) => f.won(t));
    let expected = null;
    if (at72.length === 4) expected = ["ASU", "ISU"]; // four-team tie
    else if (at72.length === 2) expected = at72; // "the two tied teams at 7-2 will be the participants"
    else if (at72.length === 3) {
      const loser = ["ASU", "BYU", "COLO", "ISU"].find((t) => !f.won(t));
      if (loser === "COLO") expected = ["ASU", "ISU"];
      if (loser === "ASU") expected = ["ISU", "BYU"];
      if (loser === "ISU") expected = ["ASU", "BYU"];
      if (loser === "BYU") {
        if (f.lost("TTU")) expected = ["ASU", "ISU"]; // West Virginia beats Texas Tech
        else if (f.won("BAY") && f.won("CIN")) expected = ["COLO", "ISU"];
        else expected = ["COLO", "ASU"]; // Baylor loss or Cincinnati loss
      }
    }
    if (!expected) continue; // fewer than two 7-2 teams: the release gives no specific pairs
    assert.equal(pairOf(f), expected.slice().sort().join(" vs "), `${at72.length} teams at 7-2: ${at72.join(", ")}`);
    checked++;
  }
  assert.ok(checked > 100, `checked ${checked} finishes`);
});

test("2024: the actual result matches (all four 6-2 teams won: ASU vs Iowa State)", () => {
  const { finishes } = replay(2024, [14]);
  const actual = finishes.find((f) => ["ASU", "BYU", "COLO", "ISU", "BAY", "TTU", "TCU", "UTAH"].every((t) => f.won(t)));
  assert.equal(pairOf(actual), "ASU vs ISU");
});

// 2025 final week: BYU 7-1, Texas Tech 7-1, ASU 6-2, Utah 6-2.
// Games: UCF at BYU, Texas Tech at West Virginia, Arizona at ASU, Utah at Kansas.
const clinch2025 = {
  BYU: (f) => f.won("BYU") || f.lost("ASU") || (f.lost("BYU") && f.lost("TTU") && f.won("ASU")),
  TTU: (f) => f.won("TTU") || f.lost("ASU"),
  ASU: (f) =>
    (f.won("ASU") && f.lost("UTAH") && f.lost("TTU")) ||
    (f.won("ASU") && f.won("TTU") && f.lost("BYU")) ||
    (f.won("ASU") && f.won("UTAH") && f.lost("TTU") && f.lost("BYU")),
  UTAH: (f) => f.won("UTAH") && f.won("ASU") && f.lost("TTU") && f.won("BYU"),
};

test("2025 final week: every published clinching condition puts that team in", () => {
  const { finishes } = replay(2025, [14]);
  assert.equal(finishes.length, 256);
  for (const f of finishes) {
    assert.ok(!f.coin);
    for (const [team, clinches] of Object.entries(clinch2025)) {
      if (clinches(f)) assert.ok(f.pair.has(team), `${team} should be in: got ${pairOf(f)}`);
    }
  }
});

test("2025 final week: a contender with no clinching condition met misses the title game", () => {
  const { finishes } = replay(2025, [14]);
  for (const f of finishes) {
    for (const [team, clinches] of Object.entries(clinch2025)) {
      if (!clinches(f)) assert.ok(!f.pair.has(team), `${team} should be out: got ${pairOf(f)}`);
    }
  }
});

test("2025: the actual result matches (ASU lost to Arizona: Texas Tech vs BYU)", () => {
  const { finishes } = replay(2025, [14]);
  const actual = finishes.find((f) => ["UTAH", "ARIZ", "TTU", "HOU", "KSU", "ISU", "BYU", "TCU"].every((t) => f.won(t)));
  assert.equal(pairOf(actual), "BYU vs TTU");
});

test("2025 week 13: the published early clinches hold whatever happens in week 14", () => {
  // Week 13 games: KU at ISU, BAY at ARIZ, KSU at UTAH, TCU at HOU, OKST at UCF, BYU at CIN,
  // ASU at COLO (Texas Tech had a bye). Weeks 13 and 14 together: 2^15 finishes.
  const { finishes } = replay(2025, [13, 14]);
  assert.equal(finishes.length, 2 ** 15);
  const early = {
    TTU: (f) => (f.lost("ASU") && f.won("BYU")) || (f.lost("ASU") && f.lost("BYU") && f.lost("UTAH")),
    BYU: (f) => (f.won("BYU") && f.lost("ASU") && f.lost("HOU")) || (f.won("BYU") && f.lost("ASU") && f.won("UTAH")),
  };
  // Known disagreement with the week-13 page (it was never revised; the week-14 page was revised
  // twice). If BYU then loses to UCF while Houston wins out and Utah loses at Kansas, BYU and
  // Houston tie at 7-2 behind Texas Tech. They're even against common opponents (4-2), and the
  // standings walk separates them at the 3-6 group TCU/UCF/Colorado: Houston 3-0, BYU 2-1 (UCF).
  // The page says BYU had clinched; the rule as written gives Houston.
  const knownDisagreement = (f) =>
    f.won("BYU", 13) && f.lost("ASU", 13) && f.won("UTAH", 13) && f.won("HOU", 13) &&
    f.lost("BYU", 14) && f.won("HOU", 14) && f.lost("UTAH", 14);
  let checked = 0, known = 0;
  for (const f of finishes) {
    const g = { won: (t) => f.won(t, 13), lost: (t) => f.lost(t, 13) }; // week-13 results only
    for (const [team, clinches] of Object.entries(early)) {
      if (!clinches(g)) continue;
      checked++;
      if (f.pair.has(team)) continue;
      assert.ok(team === "BYU" && knownDisagreement(f), `${team} clinched in week 13 but got ${pairOf(f)}`);
      assert.equal(pairOf(f), "HOU vs TTU");
      known++;
    }
  }
  assert.equal(checked, 12288 + 6144);
  assert.equal(known, 64, "only the documented branch disagrees");
});
