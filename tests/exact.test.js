// Exact solver tests. Uses the 2026-11-09 fixture with week 11 played out by the favorites,
// which leaves 16 games (65,536 finishes) so the tests run in about a second.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../engine.js");
const { solve, inputsKey, MAX_GAMES } = require("../exact.js");
const { reducedSeason } = require("./helpers.js");

const data = reducedSeason();
const ctx = B.build(data);
const ex = solve(data);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test("fixture has the expected shape", () => {
  assert.equal(ctx.pending.length, 16);
  assert.equal(ex.finishes, 2 ** 16);
  assert.ok(!ex.skipped);
});

test("odds add up: two title-game spots, one #1 seed", () => {
  near(ex.teams.reduce((s, t) => s + t.p, 0), 2, 1e-9, "sum of title-game odds");
  near(ex.teams.reduce((s, t) => s + t.first, 0), 1, 1e-9, "sum of #1-seed odds");
});

test("each game's split is consistent with the overall odds", () => {
  for (const t of ex.teams) {
    ctx.pending.forEach((g, k) => {
      const c = t.games[k];
      near(g.pHome * c.pH + (1 - g.pHome) * c.pA, t.p, 1e-9, `${t.id} game ${g.id}`);
      if (c.needH) assert.equal(c.pA, 0);
      if (c.needA) assert.equal(c.pH, 0);
    });
  }
});

test("proven labels agree with the numbers", () => {
  for (const t of ex.teams) {
    if (t.eliminated) { assert.equal(t.p, 0); assert.equal(t.best, null); }
    if (t.clinched) near(t.p, 1, 1e-9, "clinched");
    if (t.winOutGuaranteed) near(t.pWinOut, 1, 1e-9, "win out");
    if (!t.eliminated) assert.ok(t.p > 0);
  }
});

test("matches an independent Monte Carlo run", () => {
  const n = 100000;
  const sim = B.simulate(ctx, n, null, 11);
  ex.teams.forEach((t, i) => {
    const se = Math.sqrt(Math.max(t.p * (1 - t.p), 1e-6) / n);
    near(sim.appear[i] / n, t.p, 5 * se + 1e-4, ctx.teams[i].abbr);
  });
});

test("best path is the likeliest finish that qualifies, by brute force", () => {
  const P = ctx.pending;
  for (const abbr of ["UTAH", "TTU", "ARIZ"]) {
    const i = ctx.teams.findIndex((t) => t.abbr === abbr);
    let best = 0;
    for (let m = 0; m < 2 ** P.length; m++) {
      let lp = 1;
      P.forEach((g, k) => { lp *= (m >>> k) & 1 ? g.pHome : 1 - g.pHome; });
      if (lp > best && B.qualifies(ctx, m, i)) best = lp;
    }
    near(ex.teams[i].best.prob, best, 1e-15, abbr);
    assert.ok(B.qualifies(ctx, ex.teams[i].best.mask, i));
  }
});

test("cache key changes with inputs and only with inputs", () => {
  const same = JSON.parse(JSON.stringify(data));
  same.meta = { checkedAt: "later" };
  assert.equal(inputsKey(same), inputsKey(data));
  const moved = JSON.parse(JSON.stringify(data));
  moved.games.find((g) => !g.completed).pHome += 0.01;
  assert.notEqual(inputsKey(moved), inputsKey(data));
});

test("over the time budget by estimate: skipped before doing the work", () => {
  const r = solve(data, { budgetSec: 0.001 });
  assert.match(r.skipped, /would take about \d+s, over the 0\.001s budget/);
  assert.equal(r.teams, undefined);
  assert.ok(r.estimateSec >= 0);
});

test("a run that goes past its hard limit stops instead of running on", () => {
  // full 2026 fixture: 24 games. Estimate passes (huge budget), hard limit is immediate.
  const full = JSON.parse(JSON.stringify(require("./fixtures/season-2026-11-09.json")));
  const t0 = Date.now();
  const r = solve(full, { budgetSec: 1e6, deadlineSec: 0 });
  assert.match(r.skipped, /stopped after \d+s, over the 0s limit/);
  assert.ok(Date.now() - t0 < 5000, "stopped early");
});

test("within budget: finishes and records how long it took", () => {
  assert.equal(typeof ex.elapsedSec, "number");
  assert.equal(ex.budgetSec, 180);
});

test("too many unplayed games: skipped with a reason, page falls back to simulation", () => {
  const big = JSON.parse(JSON.stringify(data));
  const pending = big.games.filter((g) => !g.completed);
  for (let k = 0; big.games.filter((g) => !g.completed).length <= MAX_GAMES; k++) {
    big.games.push({ ...pending[k % pending.length], id: `extra-${k}` });
  }
  const r = solve(big);
  assert.match(r.skipped, /too many/);
  assert.equal(r.teams, undefined);
});
