"use strict";
const fs = require("fs");
const path = require("path");
const B = require("../engine.js");

const noCoin = () => { throw new Error("coin toss should not be reached"); };

// Standings built directly: records, head-to-head results, and the step d-f inputs.
// Teams are 0..n-1, named by letter. Records are set explicitly, so a team can have
// games against teams outside the test (which is how real ties look).
// rules: a league's tiebreak rules (B.RULES.sec); the Big 12's when left out.
function standingsTable(n, { records, beat = [], sos = {}, total = {}, fpi = {}, rating, rules }) {
  const H2H = new Int8Array(n * n);
  for (const [w, l] of beat) { H2H[w * n + l] = 1; H2H[l * n + w] = -1; }
  const CW = new Int16Array(n), CL = new Int16Array(n);
  records.forEach(([w, l], t) => { CW[t] = w; CL[t] = l; });
  const sosW = new Int32Array(n), sosG = new Int32Array(n);
  for (let t = 0; t < n; t++) { const [w, g] = sos[t] || [40, 81]; sosW[t] = w; sosG[t] = g; }
  const tot = new Int16Array(n);
  for (let t = 0; t < n; t++) tot[t] = total[t] ?? 8;
  const f = Array.from({ length: n }, (_, t) => (rating || fpi)[t] ?? 0);
  return { N: n, H2H, CW, CL, total: tot, sosW, sosG, rating: f, rules: rules || B.RULES.big12 };
}
const L = "ABCDEFGHIJKLMNOP".split("");
function seeds(st, rng = noCoin) {
  const trace = [];
  const s = B.titleGame(st, rng, trace, L);
  // "ABC>A:b" = A seeded at step b; "ABC-C:b" = C dropped out at step b
  const fmt = (t) => t.tied.map((i) => L[i]).join("") + (t.winner != null ? ">" + L[t.winner] : "-" + t.cut.map((i) => L[i]).join("")) + ":" + t.step;
  return { seeds: s.map((i) => L[i]), steps: trace.map(fmt) };
}


// The 2026-11-09 fixture with week 11 decided by ESPN's favorites: 16 games left.
function reducedSeason() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "season-2026-11-09.json"), "utf8"));
  for (const g of data.games) {
    if (!g.completed && g.week === 11) {
      g.completed = true;
      g.winner = g.pHome >= 0.5 ? g.home : g.away;
    }
  }
  return data;
}

// A final-season fixture with the given weeks un-played, and every finish of those games: who won
// each, and who is in the title game. For replaying published "if X wins..." scenarios.
function replayFinal(file, weeks) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8"));
  for (const g of data.games) {
    if (weeks.includes(g.week)) Object.assign(g, { completed: false, winner: null, pHome: 0.5 });
  }
  const ctx = B.build(data);
  const masks = [];
  for (let m = 0; m < 2 ** ctx.pending.length; m++) masks.push(m >>> 0);
  return { ctx, finishes: masks.map((m) => finishOf(ctx, m)), idx: indexOf(ctx) };
}

// A season snapshot with too many games left to try every combination (2026, in season): n random
// finishes of its remaining games, each game a coin flip, from a fixed seed. Not a proof like
// replayFinal, but a claim that fails shows up.
function sampleSeason(file, n, seed = 1) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8"));
  const ctx = B.build(data);
  const P = ctx.pending.length;
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  const masks = [];
  for (let k = 0; k < n; k++) {
    let m = 0;
    for (let i = 0; i < P; i++) if (rnd() & 0x10000) m |= 1 << i;
    masks.push(m >>> 0);
  }
  return { ctx, finishes: masks.map((m) => finishOf(ctx, m)), idx: indexOf(ctx) };
}

const indexOf = (ctx) => Object.fromEntries(ctx.teams.map((t, i) => [t.abbr, i]));

// One finish of ctx's remaining games (bit k of m: the home team of game k wins): who won what,
// the final conference records, and who is in the title game.
function finishOf(ctx, m) {
  const abbr = (i) => ctx.teams[i].abbr;
  const idx = indexOf(ctx);
  const out = Uint8Array.from(ctx.pending, (g, k) => (m >>> k) & 1);
  let coin = false;
  const st = B.standings(ctx, out);
  const seeds = B.titleGame(st, () => { coin = true; return 0; });
  const results = ctx.pending.map((g, k) => ({ week: g.week, teams: [abbr(g.h), abbr(g.a)], winner: abbr(out[k] ? g.h : g.a) }));
  const games = (team, week) => results.filter((r) => r.teams.includes(team) && (week == null || r.week === week));
  return {
    won: (team, week) => games(team, week).some((r) => r.winner === team),
    lost: (team, week) => games(team, week).some((r) => r.winner !== team),
    // won every remaining game / beat this particular opponent
    wonOut: (team) => games(team).every((r) => r.winner === team),
    wins: (team) => games(team).filter((r) => r.winner === team).length,
    beat: (team, opp) => results.some((r) => r.teams.includes(team) && r.teams.includes(opp) && r.winner === team),
    // final conference record, "7-2"
    rec: (team) => `${st.CW[idx[team]]}-${st.CL[idx[team]]}`,
    losses: (team) => st.CL[idx[team]],
    pair: new Set(seeds.map(abbr)),
    first: abbr(seeds[0]),
    mask: m >>> 0,
    coin,
  };
}

module.exports = { reducedSeason, standingsTable, seeds, replayFinal, sampleSeason };