// Guaranteed paths: the likeliest set of results that puts a team in the title game however the
// other games go. exact.js finds it by branch and bound over every finish; the page finds it from
// simulations when there's no enumeration (what-ifs, or too many games left). Both are checked
// against brute force over every partial set of results.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const B = require("../engine.js");
const { solve, guaranteedPath } = require("../exact.js");
const { reducedSeason } = require("./helpers.js");

// Does the team make the title game outright (no coin toss) in this finish?
function inOutright(ctx, m, t) {
  let coin = false;
  const s = B.titleGame(B.standings(ctx, Uint8Array.from(ctx.pending, (g, k) => (m >>> k) & 1)), () => { coin = true; return 0; });
  return !coin && (s[0] === t || s[1] === t);
}
// Every finish consistent with the set (games fixed to homeWins) puts the team in outright.
// fixedExtra: other games held fixed too (picks), as [mask, homeWins].
function guarantees(ctx, t, games, homeWins, [xMask, xWins] = [0, 0]) {
  const n = ctx.pending.length, all = (2 ** n - 1) >>> 0;
  const fix = (games | xMask) >>> 0, vals = (homeWins | xWins) >>> 0;
  const free = (~fix & all) >>> 0;
  let sub = 0;
  do { if (!inOutright(ctx, (vals | sub) >>> 0, t)) return false; sub = (sub - free) & free; } while (sub !== 0);
  return true;
}
const probOf = (ctx, games, homeWins) => ctx.pending.reduce((p, g, k) => ((games >>> k) & 1 ? p * ((homeWins >>> k) & 1 ? g.pHome : 1 - g.pHome) : p), 1);
const label = (ctx, games, homeWins) => ctx.pending.map((g, k) => k).filter((k) => (games >>> k) & 1)
  .map((k) => { const g = ctx.pending[k], w = (homeWins >>> k) & 1; return `${ctx.teams[w ? g.h : g.a].abbr}>${ctx.teams[w ? g.a : g.h].abbr}`; }).join(" ");

// A past season with its final week reopened (8 games, so 3^8 partial sets to brute-force), with
// uneven odds from a fixed seed so the likeliest set is unique.
function finalWeekReopened(file) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8"));
  const last = Math.max(...d.games.map((g) => g.week));
  let s = 3;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (const g of d.games) if (g.week === last) Object.assign(g, { completed: false, winner: null, pHome: 0.15 + 0.7 * rnd() });
  return d;
}
// Brute force: the likeliest guaranteeing set over all 3^n partial sets.
function bruteForce(ctx, t) {
  const n = ctx.pending.length;
  let best = null;
  for (let c = 0; c < 3 ** n; c++) {
    let games = 0, homeWins = 0, x = c;
    for (let k = 0; k < n; k++, x = Math.floor(x / 3)) {
      const d = x % 3; // 0 open, 1 home wins, 2 away wins
      if (d) { games |= 1 << k; if (d === 1) homeWins |= 1 << k; }
    }
    const p = probOf(ctx, games, homeWins);
    if (best && p <= best.prob) continue;
    if (guarantees(ctx, t, games >>> 0, homeWins >>> 0)) best = { games: games >>> 0, homeWins: homeWins >>> 0, prob: p };
  }
  return best;
}

for (const file of ["final-2024.json", "final-2025.json", "final-sec-2024.json", "final-sec-2025.json"]) {
  test(`exact guaranteed path is the likeliest over every partial set: ${file}, last week reopened`, () => {
    const d = finalWeekReopened(file);
    const ctx = B.build(d);
    const ex = solve(d);
    let found = 0;
    ex.teams.forEach((et, t) => {
      const bf = bruteForce(ctx, t);
      if (!bf) { assert.equal(et.need, null, `${ctx.teams[t].abbr}: nothing guarantees it`); return; }
      found++;
      assert.ok(et.need, `${ctx.teams[t].abbr}: has a guaranteed path`);
      assert.ok(Math.abs(et.need.prob - bf.prob) < 1e-12, `${ctx.teams[t].abbr}: ${et.need.prob} vs brute force ${bf.prob} (${label(ctx, bf.games, bf.homeWins)})`);
      assert.ok(guarantees(ctx, t, et.need.games, et.need.homeWins), `${ctx.teams[t].abbr}: the set guarantees it`);
    });
    assert.ok(found >= 2, "fixture has contenders");
  });
}

const data = reducedSeason();
const ctx = B.build(data);
const ex = solve(data);
const T = ctx.teams, P = ctx.pending;
const ti = (abbr) => T.findIndex((t) => t.abbr === abbr);

test("guaranteed paths on the 16-game fixture: enough on their own, and every game in them needed", () => {
  let n = 0;
  ex.teams.forEach((et, t) => {
    if (!et.need) return;
    n++;
    const { games, homeWins } = et.need;
    assert.ok(guarantees(ctx, t, games, homeWins), `${T[t].abbr}: guarantees it`);
    for (let k = 0; k < P.length; k++) {
      if (!((games >>> k) & 1)) continue;
      const g2 = (games & ~(1 << k)) >>> 0;
      assert.ok(!guarantees(ctx, t, g2, (homeWins & g2) >>> 0), `${T[t].abbr}: game ${k} is needed`);
    }
  });
  assert.ok(n >= 4);
});

test("Utah needs only to beat West Virginia, not to win out (fixture after week 11)", () => {
  const u = ex.teams[ti("UTAH")].need;
  assert.equal(label(ctx, u.games, u.homeWins), "UTAH>WVU");
  assert.ok(u.prob > 0.9);
});

test("eliminated teams, and teams only a coin toss could put in, have no guaranteed path", () => {
  ex.teams.forEach((et, t) => { if (et.eliminated) assert.equal(et.need, null, T[t].abbr); });
});

test("guaranteedPath gives up when told to stop", () => {
  // a long shot on the 16-game fixture takes many nodes; stop at once
  const t = ex.teams.findIndex((et) => et.need && et.need.prob < 0.01);
  const bits = new Uint32Array(Math.max(1, 2 ** P.length >>> 5));
  for (let m = 0; m < 2 ** P.length; m++) if (inOutright(ctx, m, t)) bits[m >>> 5] |= 1 << (m & 31);
  const start = ex.teams[t].best.mask;
  assert.ok(guaranteedPath(bits, P.map((g) => g.pHome), start, () => false));
  assert.equal(guaranteedPath(bits, P.map((g) => g.pHome), start, () => true), null);
});

// The simulation version, as the page runs it: weighted, coin-flip and forced-win-out runs.
function simsFor(ctx2, t, locks) {
  return [
    B.simulate(ctx2, 40000, locks, 1),
    B.simulate(ctx2, 30000, locks, 2, { uniform: true }),
    B.simulate(ctx2, 15000, locks, 3, { forceTeam: t }),
  ];
}

test("from simulations: same set as exact for every team with real odds, and never a wrong one", () => {
  let same = 0, n = 0;
  ex.teams.forEach((et, t) => {
    if (et.p < 0.005) return;
    n++;
    const r = B.guaranteedPathSim(ctx, t, simsFor(ctx, t, null), null);
    assert.ok(r, `${T[t].abbr}: found a set`);
    assert.ok(guarantees(ctx, t, r.games, r.homeWins), `${T[t].abbr}: ${label(ctx, r.games, r.homeWins)} guarantees it`);
    assert.ok(r.prob <= et.need.prob + 1e-12, `${T[t].abbr}: can't beat the exact best`);
    if (r.games === et.need.games && r.homeWins === et.need.homeWins) same++;
  });
  assert.ok(n >= 5);
  assert.equal(same, n, "matches exact");
});

test("from simulations with picks: picks stay out of the set, and the set plus picks guarantees it", () => {
  const u = ti("UTAH"), k = P.findIndex((g) => [g.h, g.a].includes(u) && [g.h, g.a].includes(ti("WVU")));
  const locks = new Array(P.length).fill(undefined);
  locks[k] = P[k].h === u ? 0 : 1; // Utah loses to West Virginia
  let found = 0;
  for (const abbr of ["UTAH", "BYU", "HOU"]) {
    const t = ti(abbr);
    const r = B.guaranteedPathSim(ctx, t, simsFor(ctx, t, locks), locks);
    if (!r) continue;
    found++;
    assert.equal((r.games >>> k) & 1, 0, `${abbr}: the pick isn't part of the set`);
    assert.ok(guarantees(ctx, t, r.games, r.homeWins, [1 << k, (locks[k] << k) >>> 0]), `${abbr}: set + pick guarantees it`);
  }
  assert.ok(found >= 2);
});
