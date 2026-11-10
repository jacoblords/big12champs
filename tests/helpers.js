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

module.exports = { reducedSeason, standingsTable, seeds };
