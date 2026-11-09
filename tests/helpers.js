"use strict";
const fs = require("fs");
const path = require("path");

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

module.exports = { reducedSeason };
