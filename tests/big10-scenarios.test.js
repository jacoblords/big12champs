// Big Ten title-game scenarios as the conference published them, replayed exhaustively. For each
// publication: un-play the games still ahead when it was written, try every combination of their
// results, and check every finish a scenario covers. A scenario names the results that matter;
// every other game is left free, so the claim has to hold whatever those other games do.
//
// Sources (the Big Ten's own):
//   2024, after week 12 (two weeks left; standings Oregon 8-0, Indiana 7-0, Ohio State 6-1, Penn
//     State 6-1): "2024 Discover Big Ten Football Championship Game Tiebreaker Scenarios", PDF
//     created Nov. 19, 2024, at assets.contentstack.io/.../B1G_2024_Tiebreaker_Scenarios.pdf
//     (Wayback copy of 2024-11-19). Ten scenarios with their deciding steps.
//   2025, after week 13 (one week left): "2025 Discover Big Ten Football Championship Game
//     Tiebreakers", Big Ten Communications, Nov. 23, 2025, bigten.org/fb/article/58967/ (Wayback
//     copy of 2025-11-26). Seven scenarios, with the step-by-step for the ties.
// Where the engine disagrees with a scenario, the trace shows the sheet overlooked something; each
// such exception is pinned below with the step that decides it.
//   No press scenarios were needed: the conference covered both seasons' final weeks itself.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { replayFinal } = require("./helpers.js");

const pairOf = (f) => [...f.pair].sort().join(" vs ");
// Check a scenario on every finish it covers: the pair, and #1 when the scenario names it.
function check(finishes, covers, pair, label, first) {
  const want = [...pair].sort().join(" vs ");
  let n = 0;
  const bad = [];
  for (const f of finishes) {
    if (!covers(f)) continue;
    n++;
    if (f.coin) bad.push("a random draw");
    else if (pairOf(f) !== want) bad.push(pairOf(f));
    else if (first && f.first !== first) bad.push(`${f.first} first`);
  }
  assert.ok(n > 0, `${label}: the scenario covers some finish`);
  assert.equal(bad.length, 0, `${label}: ${bad.length} of ${n} finishes disagree, e.g. ${bad[0]} (expected ${want}${first ? ", " + first + " #1" : ""})`);
  return n;
}
// Step 4 decides between two teams, except where their opponents' records are exactly equal
// (same wins over the same number of games): then step 5, the rating, does. Returns how many
// finishes were exact ties.
function onStep4(ctx, finishes, covers, teams, label) {
  let level = 0;
  for (const f of finishes.filter(covers)) {
    const { tr, ex } = decision(ctx, f, teams);
    assert.ok(tr, `${label}: ${teams.join(" and ")} are tied`);
    const [x, y] = tr.tied;
    const even = ex.st.sosW[x] * ex.st.sosG[y] === ex.st.sosW[y] * ex.st.sosG[x];
    assert.equal(tr.step, even ? "f" : "d", `${label}: step 4 decides unless it is an exact tie`);
    if (even) level++;
  }
  return level;
}
// The trace decision among exactly these teams.
function decision(ctx, f, teams) {
  const ex = B.explain(ctx, f.mask);
  const ab = (i) => ctx.teams[i].abbr;
  const key = [...teams].sort().join();
  return { ex, ab, tr: ex.trace.find((t) => t.tied.map(ab).sort().join() === key) };
}

test("2024 after week 12 (the conference's ten scenarios)", () => {
  const { ctx, finishes } = replayFinal("final-big10-2024.json", [13, 14]);
  assert.equal(finishes.length, 2 ** 16);
  // Results the scenarios name. OSU-IU is week 13, OSU-MICH, ORE-WASH and IU-PUR week 14; Penn
  // State plays Minnesota and Maryland. Oregon had a bye in week 13.
  const S = {
    oreWins: (f) => f.beat("ORE", "WASH"),
    oreLoses: (f) => f.beat("WASH", "ORE"),
    iuBeatsOsu: (f) => f.beat("IU", "OSU"),
    osuBeatsIu: (f) => f.beat("OSU", "IU"),
    iuBeatsPur: (f) => f.beat("IU", "PUR"),
    purBeatsIu: (f) => f.beat("PUR", "IU"),
    osuBeatsMich: (f) => f.beat("OSU", "MICH"),
    michBeatsOsu: (f) => f.beat("MICH", "OSU"),
    psuWinsOut: (f) => f.wonOut("PSU"),
  };
  const all = (...cs) => (f) => cs.every((c) => c(f));

  // #1: Oregon and Indiana 9-0, Penn State 8-1, Ohio State 7-2: Oregon and Indiana, seeded "based
  // on highest cumulative conference winning percentage of all conference opponents".
  const s1 = all(S.oreWins, S.iuBeatsOsu, S.iuBeatsPur, S.psuWinsOut, S.osuBeatsMich);
  // Exception: in 64 of these finishes the two have exactly the same opponents' record (both
  // x/81), and step 5, the rating, seeds them. The sheet doesn't consider an exact tie.
  check(finishes, s1, ["ORE", "IU"], "#1");
  assert.equal(onStep4(ctx, finishes, s1, ["ORE", "IU"], "#1"), 64);

  // #2: Oregon 9-0; Indiana and Penn State 8-1, both lost to Ohio State; Ohio State 7-2 (lost to
  // Oregon and Michigan). Oregon #1; step 4 decides Indiana or Penn State. (This is how 2024 ended.)
  const s2 = all(S.oreWins, S.osuBeatsIu, S.iuBeatsPur, S.psuWinsOut, S.michBeatsOsu);
  // Exception: in 40 of these finishes the two are exactly level on step 4, and the rating decides.
  for (const f of finishes.filter(s2)) assert.equal(f.first, "ORE", "#2: Oregon #1");
  assert.equal(onStep4(ctx, finishes, s2, ["IU", "PSU"], "#2"), 40);

  // #3: Oregon 9-0; Indiana (lost to Purdue) and Penn State 8-1; Ohio State lost to Oregon and
  // Indiana. Indiana #2 on the common opponent Ohio State.
  check(finishes, all(S.oreWins, S.iuBeatsOsu, S.purBeatsIu, S.psuWinsOut, S.osuBeatsMich), ["ORE", "IU"], "#3", "ORE");

  // #4: Oregon 9-0; Indiana, Ohio State, Penn State 8-1, Ohio State beat both: Ohio State #2.
  check(finishes, all(S.oreWins, S.osuBeatsIu, S.iuBeatsPur, S.psuWinsOut, S.osuBeatsMich), ["ORE", "OSU"], "#4", "ORE");

  // #5: Indiana 9-0; Oregon (lost to Washington) and Penn State 8-1; Ohio State 7-2 (lost to
  // Indiana and Oregon). Oregon #2 on the common opponent Ohio State.
  check(finishes, all(S.oreLoses, S.iuBeatsOsu, S.iuBeatsPur, S.psuWinsOut, S.osuBeatsMich), ["IU", "ORE"], "#5", "IU");

  // #6: Ohio State, Oregon, Penn State 8-1; Indiana 7-2 (lost to Ohio State and Purdue). Ohio
  // State in first on step 4, Oregon beats Penn State on the common opponent Ohio State, and
  // Oregon is #1 for beating Ohio State.
  const s6 = all(S.oreLoses, S.osuBeatsIu, S.purBeatsIu, S.psuWinsOut, S.osuBeatsMich);
  check(finishes, s6, ["OSU", "ORE"], "#6", "ORE");
  for (const f of finishes.filter(s6)) {
    const { ex, ab } = decision(ctx, f, ["OSU", "ORE", "PSU"]);
    const first = ex.trace[0];
    assert.deepEqual([first.tied.map(ab).sort().join(), first.step, ab(first.winner)], ["ORE,OSU,PSU", "d", "OSU"]);
  }

  // #7: Indiana (lost to Purdue), Oregon (lost to Washington), Penn State 8-1; Ohio State lost to
  // Oregon and Indiana. Indiana and Oregon beat the common opponent Ohio State; Indiana #1 because
  // Washington, which beat Oregon, finished above Purdue, which beat Indiana.
  check(finishes, all(S.oreLoses, S.iuBeatsOsu, S.purBeatsIu, S.psuWinsOut, S.osuBeatsMich), ["IU", "ORE"], "#7", "IU");

  // #8: Indiana, Ohio State, Oregon 8-1 (Ohio State beat Indiana, Washington beat Oregon); Penn
  // State 7-2. Ohio State first on step 4, then Oregon; Oregon #1 on head-to-head.
  const psuLosesOne = (f) => f.beat("MINN", "PSU") !== f.beat("MD", "PSU");
  check(finishes, all(S.oreLoses, S.osuBeatsIu, S.iuBeatsPur, psuLosesOne, S.osuBeatsMich), ["OSU", "ORE"], "#8", "ORE");

  // #9: Indiana, Ohio State, Oregon, Penn State all 8-1. Ohio State first on step 4, then Oregon
  // on the common opponent Ohio State; Oregon #1.
  check(finishes, all(S.oreLoses, S.osuBeatsIu, S.iuBeatsPur, S.psuWinsOut, S.osuBeatsMich), ["OSU", "ORE"], "#9", "ORE");

  // #10: Oregon 9-0 or 8-1; Penn State 8-1; Indiana and Ohio State 7-2 (Indiana lost to Ohio State
  // and Purdue; Ohio State to Oregon and Michigan). Oregon and Penn State, Oregon #1.
  check(finishes, all(S.osuBeatsIu, S.purBeatsIu, S.psuWinsOut, S.michBeatsOsu), ["ORE", "PSU"], "#10", "ORE");
});

test("2025 after week 13 (the conference's seven scenarios)", () => {
  const { ctx, finishes } = replayFinal("final-big10-2025.json", [14]);
  assert.equal(finishes.length, 2 ** 9);
  const iu = (f) => f.beat("IU", "PUR"), osu = (f) => f.beat("OSU", "MICH"), ore = (f) => f.beat("ORE", "WASH");
  const not = (c) => (f) => !c(f);
  const all = (...cs) => (f) => cs.every((c) => c(f));

  // #1 Indiana and Ohio State win: both 9-0.
  check(finishes, all(iu, osu), ["OSU", "IU"], "#1");
  // #2 Michigan beats Ohio State, Oregon wins: Michigan, Ohio State, Oregon 8-1 for #2. Nobody
  // beat both others, all 2-0 against Washington and Wisconsin, and Oregon has the best
  // opponents' record.
  const s2 = all(iu, not(osu), ore);
  check(finishes, s2, ["IU", "ORE"], "#2", "IU");
  for (const f of finishes.filter(s2)) {
    const { tr, ab } = decision(ctx, f, ["MICH", "ORE", "OSU"]);
    assert.deepEqual([tr.step, ab(tr.winner)], ["d", "ORE"]);
  }
  // #3 Michigan beats Ohio State, Washington beats Oregon: Michigan on head-to-head.
  check(finishes, all(iu, not(osu), not(ore)), ["IU", "MICH"], "#3", "IU");
  // #4 Ohio State wins, Purdue beats Indiana, Oregon wins: Indiana beat Oregon.
  check(finishes, all(not(iu), osu, ore), ["OSU", "IU"], "#4", "OSU");
  // #5 Purdue, Michigan and Oregon win: four teams at 8-1. Oregon first on step 4; then Indiana
  // drops out on common opponents and Michigan beats Ohio State head-to-head.
  const s5 = all(not(iu), not(osu), ore);
  check(finishes, s5, ["ORE", "MICH"], "#5");
  for (const f of finishes.filter(s5)) {
    const { ex, ab } = decision(ctx, f, []);
    const fmt = (t) => t.tied.map(ab).sort().join() + (t.winner != null ? ">" + ab(t.winner) : "-" + t.cut.map(ab).join()) + ":" + t.step;
    assert.deepEqual(ex.trace.slice(0, 3).map(fmt), ["IU,MICH,ORE,OSU>ORE:d", "IU,MICH,OSU-IU:b", "MICH,OSU>MICH:a"]);
  }
  // #6 Purdue, Michigan and Washington win: Indiana, Ohio State, Michigan 8-1; Indiana drops out on
  // common opponents, and Ohio State and Michigan are both in.
  check(finishes, all(not(iu), not(osu), not(ore)), ["MICH", "OSU"], "#6", "MICH");
  // #7 Purdue, Ohio State and Washington win: Ohio State 9-0, Indiana 8-1.
  check(finishes, all(not(iu), osu, not(ore)), ["OSU", "IU"], "#7", "OSU");
});
