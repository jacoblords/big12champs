// Pac-12 tiebreakers (the rebuilt league's first season, 2026): the procedure clause by clause,
// the places it differs from the other leagues, and reporters' scenarios from November 2026.
// There are no past title games to replay: 2026 is the first season of these eight teams.
// Run: node --test tests/
//
// Sources:
//   Procedure: "Pac-12 Football Championship Game Tiebreakers", in the conference's release of
//     Sept. 3, 2026, "Pac-12 announces commercial and operational updates ahead of its 2026
//     football season kickoff" (pac-12.com/news/2026/9/3/...). Eight teams play a seven-game round
//     robin, weeks 5-12; week 13's "home-and-home flex matchup ... will not count toward conference
//     standings". The title game (Dec. 4) is at the higher seed's home.
//   Two teams: "If two teams are tied for first place both teams will participate in the
//     championship game and the winner of the head-to-head will be the No. 1 seed. If there is not
//     a tie for first place, but two teams are tied for second place, the two-team tiebreaker
//     policy will apply". The numbered list goes on: standings walk (tied groups counted together),
//     common conference opponents, CFP ranking on the Tuesday before week 13, SportSource Team
//     Rating Score, coin toss. It doesn't list head-to-head for a tie for second; the conference's own
//     Nov. 11 scenarios (below) need it: all nine of its statements hold with head-to-head first,
//     and six fail without it (73 of the 256 finishes change, checked with a patched engine).
//     Reporters use it too (MWC Connection, Fresno Bee). The engine applies head-to-head first.
//   Three or more: 1. head-to-head ("If every tied team has not played one another, the process
//     moves to the next criterion"); 2. common conference opponents; 3. standings walk, tied groups
//     counted together; 4. "Combined Conference winning percentage of Conference opponents";
//     5. SportSource Team Rating Score (private: FPI stands in); 6. coin toss. "Once one team gains
//     an advantage and is seeded, the remaining teams will restart ... If the process reduces the
//     tie to two teams, the two-team procedure will then be applied."
//   The conference's own scenarios: "This Week in Pac-12 Football - Week 11" (pac-12.com, Nov. 11,
//     2026, "Chase for the Champ Game"), written with the same eight games left.
//   Press scenarios: MWC Connection, "Stats Corner: PAC-12 Title Race Four Teams, One Trip to Boise"
//     (Nov. 12, 2026, before week 11); Fresno Bee, "Little room for error" (Nov. 9, 2026). Both
//     were written with the same eight games left as the Nov. 13 snapshot.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { standingsTable, seeds, replayFinal } = require("./helpers.js");

const P12 = B.RULES.pac12;
const SNAP = "pac12-season-2026-11-13.json";
const fixture = (name) => JSON.parse(JSON.stringify(require(`./fixtures/${name}`)));

// every claim is checked over all 256 finishes of the eight games left on Nov. 13
const { ctx, finishes } = replayFinal(SNAP, []);
const ab = (i) => ctx.teams[i].abbr;
function check(label, when, claim) {
  const covered = finishes.filter(when);
  assert.ok(covered.length > 0, label + ": no finish covered");
  const bad = covered.filter((f) => !claim(f));
  assert.deepEqual(bad.map((f) => f.mask), [], label);
  return covered.length;
}

test("Pac-12 data is read with Pac-12 rules: eight teams, a seven-game round robin, flex games left out", () => {
  const data = fixture(SNAP);
  assert.equal(ctx.rules, P12);
  assert.equal(B.rulesFor("pac12", 2026), P12);
  assert.equal(ctx.N, 8);
  // every pair meets exactly once in a conference game
  const met = new Map();
  for (const g of data.games.filter((x) => x.conf)) {
    const k = [g.home, g.away].sort().join("-");
    met.set(k, (met.get(k) || 0) + 1);
  }
  assert.equal(met.size, 28);
  assert.ok([...met.values()].every((n) => n === 1));
  // week 13's flex games are in the data but not in the standings
  const flex = data.games.filter((g) => g.week === 13);
  assert.ok(flex.length > 0);
  assert.ok(flex.every((g) => !g.conf));
  assert.equal(ctx.pending.length, 8, "only weeks 11 and 12 are left to enumerate");
  assert.ok(ctx.pending.every((g) => g.week === 11 || g.week === 12));
});

test("in a round robin, steps 2 and 4 never decide anything: head-to-head already said it", () => {
  // Tied teams have the same record, and record against common opponents is that record minus
  // their games against each other, which step 1 compared. Opponents' combined record is the
  // league's total wins minus a team's own, so it is level too.
  const steps = new Set();
  for (const f of finishes) for (const t of B.explain(ctx, f.mask).trace) steps.add(t.step);
  assert.deepEqual([...steps].sort(), ["a", "c", "f"]);
  assert.ok(!finishes.some((f) => f.coin), "no finish reaches the coin toss");
});

// ---- the procedure, clause by clause ----

test("two teams tied for first both play; the head-to-head winner is #1 and hosts", () => {
  const st = standingsTable(3, { records: [[6, 1], [6, 1], [4, 3]], beat: [[1, 0]], rules: P12 });
  assert.deepEqual(seeds(st), { seeds: ["B", "A"], steps: ["AB>B:a"] });
});

test("two teams tied for second: the head-to-head winner is #2", () => {
  const st = standingsTable(3, { records: [[7, 0], [5, 2], [5, 2]], beat: [[2, 1]], rules: P12 });
  assert.deepEqual(seeds(st), { seeds: ["A", "C"], steps: ["BC>C:a"] });
});

test("three tied for first who split their games: the walk seeds #1, then head-to-head settles #2", () => {
  // The Nov. 13 snapshot, finish 145: Boise State, Texas State and Oregon State 5-2, each 1-1
  // against the others. Against San Diego State and Utah State (tied 4-3, counted together)
  // Oregon State is 2-0, the others 1-1. Oregon State is #1; Boise State beat Texas State for #2.
  const ex = B.explain(ctx, 145);
  assert.deepEqual(ex.seeds.map(ab), ["ORST", "BOIS"]);
  assert.deepEqual(ex.trace.map((t) => [t.tied.map(ab).sort().join(" "), t.step, ab(t.winner)]),
    [["BOIS ORST TXST", "c", "ORST"], ["BOIS TXST", "a", "BOIS"]]);
  assert.deepEqual(ex.trace[0].against.map(ab).sort(), ["SDSU", "USU"]);
});

test("a tie the walk can't split goes to the rating (FPI standing in for SportSource)", () => {
  // Finish 207: Texas State, Oregon State and San Diego State 4-3 behind Boise State, each 1-1
  // against the others and level all the way down the standings.
  const ex = B.explain(ctx, 207);
  assert.deepEqual(ex.seeds.map(ab), ["BOIS", "TXST"]);
  assert.deepEqual(ex.trace.map((t) => [t.tied.map(ab).sort().join(" "), t.step, ab(t.winner)]),
    [["ORST SDSU TXST", "f", "TXST"]]);
});

test("a step that drops one of three sends the other two back to head-to-head", () => {
  // Finish 231: Texas State, Oregon State and San Diego State 4-3 for #2. Against Fresno State and
  // Utah State, Oregon State is 1-1 and the others 2-0, so it drops out; San Diego State beat
  // Texas State, 31-29.
  const ex = B.explain(ctx, 231);
  assert.deepEqual(ex.seeds.map(ab), ["BOIS", "SDSU"]);
  assert.deepEqual(ex.trace.map((t) => [t.step, t.winner != null ? ab(t.winner) : "-" + t.cut.map(ab).join()]),
    [["c", "-ORST"], ["a", "SDSU"]]);
});

// Each place the Pac-12 differs from another league, on a table that comes out differently under
// the two rule sets. (Outside a canceled game, a full round robin never reaches the first two.)

test("not everyone played (a canceled game): a team that lost to all the others stays in (unlike the SEC)", () => {
  // (Head-to-head is skipped altogether, so nobody comes out at step 1 either way.)
  const table = (rules) => standingsTable(4, {
    records: [[7, 0], [5, 1], [5, 1], [5, 1]],
    beat: [[1, 3], [2, 3]],
    sos: { 1: [20, 41], 2: [19, 41], 3: [23, 41] },
    rules,
  });
  assert.deepEqual(seeds(table(P12)), { seeds: ["A", "D"], steps: ["BCD>D:d"] });
  assert.deepEqual(seeds(table(B.RULES.sec)), { seeds: ["A", "B"], steps: ["BCD-D:a", "BC>B:d"] });
});

test("not everyone played (a canceled game): head-to-head is skipped, even for a team that beat all the others (unlike the Big 12)", () => {
  // "If every tied team has not played one another, the process moves to the next criterion."
  // A, B, C 5-1; B-C was canceled; A beat B and C; D beat A and lost to B and C. Step 2: against D,
  // A is 0-1, B and C 1-0, so A drops out. The Big 12 seeds A at head-to-head first.
  const table = (rules) => standingsTable(4, {
    records: [[5, 1], [5, 1], [5, 1], [3, 3]],
    beat: [[0, 1], [0, 2], [3, 0], [1, 3], [2, 3]],
    fpi: { 1: 5, 2: 3 },
    rules,
  });
  assert.equal(P12.h2hAllPlayedOnly, true);
  const p12 = seeds(table(P12));
  assert.deepEqual(p12.seeds.slice().sort(), ["B", "C"]);
  assert.equal(p12.steps[0], "ABC-A:b");
  assert.deepEqual(seeds(table(B.RULES.big12)), { seeds: ["A", "B"], steps: ["ABC>A:a", "BC>B:f"] });
});

test("the conference's own scenarios rule out the other readings of the gaps in the text", () => {
  // Checked with a patched engine (see the header): without head-to-head for a tie for second, six
  // of the nine Nov. 11 statements fail; if nobody dropped out of a tie when a step leaves several
  // level at the top, two fail (finish 69 is one where it matters). Here, finish 69 as the engine
  // runs it: Boise State 6-1; Texas State, Oregon State, San Diego State and Utah State 4-3, with
  // Texas State and San Diego State 2-1 among them. Oregon State and Utah State drop out, and San
  // Diego State beat Texas State.
  const ex = B.explain(ctx, 69);
  assert.deepEqual(ex.seeds.map(ab), ["BOIS", "SDSU"]);
  assert.deepEqual(ex.trace.map((t) => [t.step, t.winner != null ? ab(t.winner) : "-" + t.cut.map(ab).sort().join()]),
    [["a", "-ORST,USU"], ["a", "SDSU"]]);
});

test("the walk counts a tied group of opponents together (unlike the SEC)", () => {
  // B and C tied for #2, never met. D and E tied below them, D beat E. B beat D and lost to E;
  // C lost to D and beat E. Together both are 1-1; the SEC orders D first, where B wins.
  const table = (rules) => standingsTable(5, {
    records: [[7, 0], [5, 1], [5, 1], [3, 3], [3, 3]],
    beat: [[1, 3], [4, 1], [3, 2], [2, 4], [3, 4]],
    sos: { 1: [20, 41], 2: [22, 41] },
    rules,
  });
  assert.deepEqual(seeds(table(P12)), { seeds: ["A", "C"], steps: ["BC>C:d"] });
  assert.deepEqual(seeds(table(B.RULES.sec)), { seeds: ["A", "B"], steps: ["BC>B:c"] });
});

test("seeds go in the order teams come out: no re-seeding of the two who get in (unlike the Big Ten)", () => {
  const table = (rules) => standingsTable(3, {
    records: [[6, 1], [6, 1], [6, 1]],
    beat: [[1, 0], [0, 2]],
    sos: { 0: [25, 42], 1: [21, 42], 2: [20, 42] },
    rules,
  });
  assert.deepEqual(seeds(table(P12)).seeds, ["A", "B"]);
  assert.deepEqual(seeds(table(B.RULES.big10)).seeds, ["B", "A"]);
});

test("after a cut, three still level start over at head-to-head (unlike the Big Ten)", () => {
  const table = (rules) => standingsTable(7, {
    records: [[7, 0], [5, 2], [5, 2], [5, 2], [5, 2], [2, 5], [1, 6]],
    // B, C, D all met (B 2-0, C 1-1); E never met B, so step 1 doesn't apply to all four. E lost
    // to F, so step 2 drops E. Restarted, B, C, D all played: B is in on head-to-head. The Big Ten
    // goes on instead (step 3 even: F only), and step 4 picks C.
    beat: [[1, 2], [1, 3], [2, 3], [1, 5], [2, 5], [3, 5], [5, 4]],
    sos: { 1: [20, 42], 2: [24, 42], 3: [22, 42], 4: [25, 42] },
    rules,
  });
  assert.deepEqual(seeds(table(P12)), { seeds: ["A", "B"], steps: ["BCDE-E:b", "BCD>B:a"] });
  assert.deepEqual(seeds(table(B.RULES.big10)), { seeds: ["A", "C"], steps: ["BCDE-E:b", "BCD>C:d"] });
});

// ---- reporters' scenarios, Nov. 9-12, 2026 (eight games left), over every finish ----

test("Boise State: one more win clinches the #1 seed and the home game", () => {
  // MWC Connection: "Assuming Boise State takes care of business in its final two contests, the
  // Broncos will host the championship game"; one win is enough, since nobody else can reach 6-1.
  check("BOIS wins one", (f) => f.wins("BOIS") >= 1, (f) => f.first === "BOIS");
  // Losing both still leaves it in, except in the 16 finishes where Oregon State and San Diego
  // State, who beat it, finish 5-2 with it and take the spots on head-to-head.
  const out = finishes.filter((f) => f.wins("BOIS") === 0 && !f.pair.has("BOIS"));
  assert.equal(out.length, 16);
  assert.ok(out.every((f) => f.rec("ORST") === "5-2" && f.rec("SDSU") === "5-2" && f.rec("BOIS") === "5-2"));
});

test("Texas State: win out, with Boise State winning out, and it's in", () => {
  // "Their head-to-head victories over Oregon State and Utah State give them a significant
  // advantage ... Take care of business over the next two weeks, and the Bobcats should be in
  // excellent shape."
  check("TXST and BOIS win out", (f) => f.wonOut("TXST") && f.wonOut("BOIS"), (f) => f.pair.has("TXST"));
  // Not without Boise State: each of the 20 finishes where it misses has Boise State losing to
  // San Diego State (who beat Texas State, 31-29) or to Oregon State, who then reaches 5-2 too.
  const out = finishes.filter((f) => f.wonOut("TXST") && !f.pair.has("TXST"));
  assert.equal(out.length, 20);
  assert.ok(out.every((f) => (f.beat("SDSU", "BOIS") && f.rec("SDSU") === "5-2") || (f.beat("ORST", "BOIS") && f.rec("ORST") === "5-2")));
});

test("Utah State: has to win out and needs Texas State to lose", () => {
  // "Beat San Diego State ... Beat Oregon State ... Get help from Fresno State and Washington State
  // against Texas State": its 20-17 loss to the Bobcats settles any tie between them.
  check("USU in", (f) => f.pair.has("USU"), (f) => f.wonOut("USU") && !f.wonOut("TXST"));
});

test("Fresno State: one game back, it needs to win out and plenty of help", () => {
  // Fresno Bee, Nov. 9: "remains mathematically alive ... need plenty of help to get there".
  const n = check("FRES in", (f) => f.pair.has("FRES"), (f) => f.wonOut("FRES") && f.rec("FRES") === "4-3");
  assert.equal(n, 2);
});

test("head-to-head settles a two-team tie for #2 either way: San Diego State over Texas State, Oregon State over San Diego State", () => {
  // MWC Connection: SDSU's "31-29 victory over Texas State ... could become valuable if the two
  // teams finish tied. Unfortunately, the 66-14 loss to Oregon State creates the opposite problem."
  const tiedForSecond = (f, a, b) => {
    const st = B.standings(ctx, Uint8Array.from(ctx.pending, (g, k) => (f.mask >>> k) & 1));
    const groups = B.confGroups(st).map((G) => G.map(ab).sort().join(" "));
    return groups[0].split(" ").length === 1 && groups[1] === [a, b].sort().join(" ");
  };
  check("SDSU and TXST tied for #2", (f) => tiedForSecond(f, "SDSU", "TXST"), (f) => f.pair.has("SDSU"));
  check("ORST and SDSU tied for #2", (f) => tiedForSecond(f, "ORST", "SDSU"), (f) => f.pair.has("ORST"));
});

// ---- the Pac-12's own scenarios, "This Week in Pac-12 Football - Week 11" (Nov. 11, 2026) ----

test("Pac-12, Nov. 11: six of the eight teams are still in contention", () => {
  const alive = ctx.teams.map((t) => t.abbr).filter((t) => finishes.some((f) => f.pair.has(t)));
  assert.deepEqual(alive.sort(), ["BOIS", "FRES", "ORST", "SDSU", "TXST", "USU"]);
});

test("Pac-12, Nov. 11: a Boise State win this weekend clinches a spot and the home game", () => {
  // "1 win away from clinching not only a spot ... a win this weekend would also mean the
  // Broncos would be hosting the game"
  check("BOIS wins week 11", (f) => f.won("BOIS", 11), (f) => f.first === "BOIS");
});

test("Pac-12, Nov. 11: if Boise State loses both, Oregon State or San Diego State at 5-2 can host", () => {
  // "the Beavers and Aztecs would also be in contention to host ... should they get to 5 conference wins"
  for (const t of ["ORST", "SDSU"]) {
    assert.ok(finishes.some((f) => f.wins("BOIS") === 0 && f.rec(t) === "5-2" && f.first === t), t);
  }
});

test("Pac-12, Nov. 11: of the four teams at 3-2, only San Diego State is guaranteed a spot at 5-2", () => {
  check("SDSU 5-2", (f) => f.rec("SDSU") === "5-2", (f) => f.pair.has("SDSU"));
  for (const t of ["TXST", "ORST", "USU"]) {
    assert.ok(finishes.some((f) => f.rec(t) === "5-2" && !f.pair.has(t)), t + " can miss at 5-2");
  }
});

test("Pac-12, Nov. 11: Oregon State over Boise State and Utah State over San Diego State clinch Boise State a spot, not the home game", () => {
  const n = check("ORST and USU win", (f) => f.beat("ORST", "BOIS") && f.beat("USU", "SDSU"), (f) => f.pair.has("BOIS"));
  assert.equal(n, 64);
  const hosts = new Set(finishes.filter((f) => f.beat("ORST", "BOIS") && f.beat("USU", "SDSU")).map((f) => f.first));
  assert.ok(hosts.has("BOIS") && hosts.size > 1, "host still undecided");
});

test("Pac-12, Nov. 11: Utah State must win this week", () => {
  check("USU loses week 11", (f) => f.lost("USU", 11), (f) => !f.pair.has("USU"));
});

test("Pac-12, Nov. 11: Texas State is out with a loss AND an Oregon State win, but not with either alone", () => {
  check("TXST loses and ORST wins", (f) => f.lost("TXST", 11) && f.beat("ORST", "BOIS"), (f) => !f.pair.has("TXST"));
  assert.ok(finishes.some((f) => f.lost("TXST", 11) && !f.beat("ORST", "BOIS") && f.pair.has("TXST")), "a loss alone");
  assert.ok(finishes.some((f) => f.won("TXST", 11) && f.beat("ORST", "BOIS") && f.pair.has("TXST")), "an Oregon State win alone");
});

test("Pac-12, Nov. 11: Fresno State is out with a loss, or an Oregon State or San Diego State win", () => {
  check("FRES loses", (f) => f.lost("FRES", 11), (f) => !f.pair.has("FRES"));
  check("ORST beats BOIS", (f) => f.beat("ORST", "BOIS"), (f) => !f.pair.has("FRES"));
  check("SDSU beats USU", (f) => f.beat("SDSU", "USU"), (f) => !f.pair.has("FRES"));
});
