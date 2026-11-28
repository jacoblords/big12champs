// The title weekend page (title.html): runs its script against a stub DOM and checks what it renders.
"use strict";
// kickoffs are shown in the viewer's time: the tests read them in Mountain time (Friday night's
// game is Saturday in UTC)
process.env.TZ = "America/Denver";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const script = [...fs.readFileSync(path.join(root, "title.html"), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "season-2026-11-09.json"), "utf8"));
const PNG = "data:image/png;base64,iVBORw0KGgo=";

const clockAt = (iso) => {
  const t = Date.parse(iso);
  return class extends Date { constructor(...a) { if (a.length) super(...a); else super(t); } static now() { return t; } };
};
function render(data, { now = "2026-12-01T18:00Z", hash = "", extra = {} } = {}) {
  const els = {};
  const document = {
    getElementById: (id) => (els[id] ||= { id, innerHTML: "", textContent: "", hidden: false, attrs: {}, removeAttribute(k) { delete this.attrs[k]; }, scrollIntoView() { this.scrolled = true; } }),
    addEventListener() {}, hidden: false,
  };
  const sandbox = {
    document, location: { hash }, console, Math, JSON, Promise, Date: clockAt(now), Map, Set, Number, String, Array, Object, RegExp,
    fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(data)) }),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; }, clearTimeout, ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { els, sandbox };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const text = (html) => html.replace(/<img[^>]*>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// A league as title_weekend.py writes it, from the fixture's teams: team k plays team j
const T = fixture.teams;
const team = (k) => ({ ...T[k], logo: PNG, logoDark: PNG });
const season = (w, l, cw, cl, results = []) => ({ w, l, cw, cl, ppg: 30.5, papg: 20.1, top25: 2, results });
function league(id, name, path, home, away, extra = {}) {
  return {
    id, name, path, logo: PNG, logoDark: PNG, sponsor: null, seasonOver: true,
    title: { id: "t-" + id, week: 14, date: "2026-12-05T17:00Z", timeValid: true, home: T[home].id, away: T[away].id, homeName: T[home].abbr, awayName: T[away].abbr,
      completed: false, winner: null, homeScore: null, awayScore: null, tbd: false, name: `${name} Championship`, tv: "ABC", spread: `${T[home].abbr} -3`, overUnder: 51.5,
      venue: "AT&T Stadium", city: "Arlington, TX", pHome: 0.6, leaders: { [T[home].id]: [{ cat: "Passing", name: "A Passer", pos: "QB", line: "3000 YDS" }] } },
    teams: [team(home), team(away)], contenders: [],
    seeds: { [T[home].id]: 1, [T[away].id]: 2 },
    seasons: {
      [T[home].id]: season(11, 1, 8, 1, [{ id: "g1", week: 9, opp: T[away].id, oppName: T[away].abbr, home: true, neutral: false, win: true, us: 31, them: 24, conf: true },
        { id: "g2", week: 10, opp: "999", oppName: "COLO", home: false, neutral: false, win: true, us: 20, them: 10, conf: true }]),
      [T[away].id]: season(10, 2, 7, 2, [{ id: "g1", week: 9, opp: T[home].id, oppName: T[home].abbr, home: false, neutral: false, win: false, us: 24, them: 31, conf: true },
        { id: "g3", week: 11, opp: "999", oppName: "COLO", home: true, neutral: false, win: false, us: 17, them: 21, conf: true }]),
    },
    cfp: { [T[home].id]: 4 },
    ...extra,
  };
}
function weekend() {
  const big12 = league("big12", "Big 12", "", 0, 1);
  big12.title.date = "2026-12-05T01:00Z"; // Friday night: first
  const tbd = league("big10", "Big Ten", "big10/", 2, 3);
  Object.assign(tbd.title, { tbd: true, home: "-1", away: "-2", homeName: "TBD", awayName: "TBD", date: "2026-12-06T01:00Z", leaders: {} });
  Object.assign(tbd, { teams: [team(2), team(3)], seeds: {}, seasons: {}, contenders: [{ id: T[3].id, p: 0.85 }, { id: T[2].id, p: 0.4 }] });
  return { season: 2026, fetchedAt: "2026-12-01T17:00Z", leagues: [league("sec", "SEC", "sec/", 4, 5), tbd, big12, { ...league("acc", "ACC", "acc/", 6, 7), title: null }] };
}

test("every title game, in kickoff order, as a poster with seeds, records, line and ESPN's odds", async () => {
  const { els } = render(weekend());
  await settle();
  const ids = [...els.games.innerHTML.matchAll(/<article class="tg" id="([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["big12", "sec", "big10"], "kickoff order; a league with no title game listed is left out");
  const b12 = els.games.innerHTML.split("<article").find((c) => c.includes('id="big12"'));
  const t = text(b12);
  assert.match(t, new RegExp(`4 ${T[0].short} #1 11-1 · 8-1 Big 12`), "the #1 seed first, CFP rank, seed, records");
  assert.match(t, new RegExp(`${T[1].short} #2 10-2 · 7-2 Big 12`));
  assert.match(t, /Line \w+ -3 O\/U 51\.5 AT&amp;T Stadium, Arlington, TX/);
  assert.match(t, new RegExp(`${T[0].abbr} 60% ESPN's win odds 40% ${T[1].abbr}`), "the #1 seed is home here, so it's 60%");
  assert.match(t, /Week 9: .+ 31, .+ 24 in .+'s house\. A rematch\./);
  assert.match(t, /Common opponents W 20-10 COLO L 17-21/);
  assert.match(t, /Players to watch Passing A Passer QB 3000 YDS/);
  assert.match(b12, /gameId\/t-big12/);
  assert.match(els.lede.innerHTML, /^3 conference championships, Friday and Saturday\./);
  assert.equal(els.champs.hidden, true, "no champions before the games");
  assert.match(text(els.sched.innerHTML), /Friday Dec 4 .*Saturday Dec 5/);
});

test("tale of the tape marks the better number of each pair, the lower one for points allowed and CFP rank", async () => {
  const d = weekend();
  const lg = d.leagues[0];
  lg.seasons[lg.title.home].papg = 25; // worse defense for the #1 seed
  const { els } = render(d);
  await settle();
  const tape = els.games.innerHTML.split("<article").find((c) => c.includes('id="sec"')).match(/<div class="tape"[\s\S]*?<\/div>/)[0];
  const row = (k) => tape.match(new RegExp(`<span class="a( up)?"[^>]*>([^<]*)</span><span class="k" role="rowheader">${k}</span><span class="b( up)?"`)).slice(1);
  assert.deepEqual(row("Record"), [" up", "11-1", undefined]);
  assert.deepEqual(row("Allowed a game"), [undefined, "25", " up"]);
  assert.deepEqual(row("CFP ranking"), [" up", "4", undefined], "ranked beats unranked");
});

test("a matchup still to be set shows who's still in it, linked to their paths", async () => {
  const { els } = render(weekend());
  await settle();
  const card = els.games.innerHTML.split("<article").find((c) => c.includes('id="big10"'));
  assert.match(text(card), /Big Ten Championship .* Matchup to be set .* Still in the running/);
  assert.match(card, new RegExp(`href="\\.\\./big10/#${T[3].abbr.toLowerCase()}"`));
  assert.ok(card.indexOf(T[3].abbr) < card.indexOf(">" + T[2].abbr), "likeliest first");
});

test("a finished game crowns its champion, in the card and the champions row", async () => {
  const d = weekend();
  Object.assign(d.leagues[2].title, { completed: true, winner: d.leagues[2].title.away, homeScore: 20, awayScore: 27, pHome: null });
  const { els } = render(d, { now: "2026-12-05T06:00Z" });
  await settle();
  assert.equal(els.champs.hidden, false);
  assert.match(text(els.champs.innerHTML), new RegExp(`2026 champions ${T[1].short} Big 12 To be decided SEC To be decided Big Ten`));
  const card = els.games.innerHTML.split("<article").find((c) => c.includes('id="big12"'));
  assert.match(text(card), new RegExp(`Final .*20 &ndash; 27 .*${T[1].short}, Big 12 champions`));
  assert.match(card, new RegExp(`<div class="side a lost">`), "the loser dimmed");
  assert.doesNotMatch(card, /ESPN's win odds/, "no pregame odds once it's over");
  assert.match(els.lede.innerHTML, /1 champion crowned, 2 to go\./);
});

test("a game under way: live status, its score, the win-probability chart, and the live poll asks about it", async () => {
  const d = weekend();
  const g = d.leagues[0].title; // SEC, home is the #1 seed (shown first)
  g.wp = { pts: [[0, 600], [900, 700], [1800, 800]], final: false, detail: "3rd 14:00", homeScore: 21, awayScore: 10, state: "in" };
  const { els, sandbox } = render(d, { now: "2026-12-05T18:30Z" });
  await settle();
  const card = els.games.innerHTML.split("<article").find((c) => c.includes('id="sec"'));
  assert.match(card, /<span class="live"><span class="dot" aria-hidden="true"><\/span>3rd 14:00<\/span>/);
  assert.match(text(card), /21 &ndash; 10/, "the #1 seed's score first");
  assert.match(card, new RegExp(`aria-label="ESPN win probability: ${T[4].abbr} 80%, ${T[5].abbr} 20%"`));
  assert.match(els.sched.innerHTML, /class="w live"/);
  assert.deepEqual([...vm.runInContext("view.liveIds()", sandbox)], ["t-sec"]);
});

test("ESPN-supplied text is escaped", async () => {
  const d = weekend();
  Object.assign(d.leagues[0].title, { venue: "<img src=x onerror=alert(1)>", tv: "<b>TV</b>", spread: '"><script>', name: "<i>SEC</i>" });
  d.leagues[0].title.leaders[d.leagues[0].title.home][0].name = "<script>x</script>";
  const { els } = render(d);
  await settle();
  const all = els.games.innerHTML + els.sched.innerHTML;
  assert.doesNotMatch(all, /<img src=x|<b>TV|<script>|<i>SEC/);
  assert.match(all, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("a link to one game opens the page there", async () => {
  const { els } = render(weekend(), { hash: "#sec" });
  await settle();
  await new Promise((r) => setTimeout(r, 600)); // shown once its fonts are in (capped at half a second)
  assert.equal(els.page.attrs["aria-busy"], undefined);
  assert.equal(els.sec.scrolled, true);
});
