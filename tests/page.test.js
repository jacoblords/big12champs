// Page tests: runs the real page script against a stub DOM, the way the browser would,
// and checks what it renders.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { solve } = require("../exact.js");
const { reducedSeason } = require("./helpers.js");

const root = path.join(__dirname, "..");
const pageScripts = (() => {
  const html = fs.readFileSync(path.join(root, "app.html"), "utf8")
    .replace("/*__ENGINE__*/", fs.readFileSync(path.join(root, "engine.js"), "utf8"));
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
})();

function render(data, hash) {
  const els = {};
  const handlers = {};
  const document = {
    getElementById: (id) => (els[id] ||= { id, innerHTML: "", textContent: "", hidden: false, scrollIntoView() {} }),
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  const sandbox = {
    document, window: { addEventListener() {} }, location: { hash: hash || "" }, history: { replaceState() {} },
    fetch: async () => ({ ok: true, json: async () => data }), console, Math, Date, JSON,
  };
  vm.createContext(sandbox);
  for (const src of pageScripts) vm.runInContext(src, sandbox);
  return { els, handlers, sandbox };
}
const text = (html) => html.replace(/<img[^>]*>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const settle = () => new Promise((r) => setTimeout(r, 20));

const data = reducedSeason();
data.exact = solve(data);

test("loads data.json, renders every team in exact mode", async () => {
  for (const t of data.teams) {
    const { els } = render(data, "#" + t.abbr.toLowerCase());
    await settle();
    const team = text(els.team.innerHTML);
    assert.match(team, new RegExp(t.name));
    assert.match(team, /to reach the title game/);
    assert.doesNotMatch(team, /simulation/i, `${t.abbr} should not mention simulation in exact mode`);
    assert.match(els.methodText.textContent, /possible finishes/);
    assert.match(els.lede.textContent, /^Results through .*games left\. Pick a team/);
  }
});

test("standings list: seeds sort to the top of their tied group, the rest show as tied", async () => {
  let sawTie = false;
  for (const t of data.teams) {
    const { els } = render(data, "#" + t.abbr.toLowerCase());
    await settle();
    const rows = [...els.team.innerHTML.matchAll(/<span class="seed">([^<]*)<\/span><span[^>]*>[^<]*<\/span><span>(\d+-\d+)<\/span>/g)]
      .map((m) => ({ label: m[1], rec: m[2] }));
    if (!rows.length) continue; // eliminated: no path
    assert.equal(rows[0].label, "#1", `${t.abbr}: first row is the #1 seed`);
    rows.forEach((r, k) => {
      const prev = rows[k - 1];
      if (prev && prev.rec === r.rec && r.label.startsWith("#")) {
        assert.ok(prev.label.startsWith("#"), `${t.abbr}: ${r.label} listed below unseeded ${prev.label} at ${r.rec}`);
      }
      if (r.label.startsWith("T")) sawTie = true;
    });
  }
  assert.ok(sawTie, "fixture should include a path with teams left tied");
});

test("with no team in the link, it opens on the conference leader", async () => {
  // fixture after week 11 by favorites: Utah is 7-0
  const { els } = render(data, "");
  await settle();
  assert.match(text(els.team.innerHTML), /Utah Utes 7-0 Big 12/);
});

test("picker cards show the record and an odds pill that fills with the odds", async () => {
  const { els } = render(data, "#utah");
  await settle();
  const cards = [...els.picker.innerHTML.matchAll(/<span class="ab">([^<]+)<\/span><span class="rec">(\d+-\d+)<\/span><span class="odds( hot)?"><i style="width:([\d.]+)%"><\/i><b>([^<]+)<\/b><\/span>/g)]
    .map((m) => ({ abbr: m[1], rec: m[2], hot: !!m[3], fill: parseFloat(m[4]), label: m[5] }));
  assert.equal(cards.length, data.teams.length);
  const utah = cards.find((c) => c.abbr === "UTAH");
  assert.equal(utah.rec, "7-0");
  assert.ok(utah.hot && utah.fill > 50, "a favorite's pill is highlighted and mostly filled");
  for (const c of cards) {
    if (c.label === "0%") assert.equal(c.fill, 0, `${c.abbr}: eliminated team has an empty pill`);
    else assert.ok(c.fill >= 3, `${c.abbr}: any chance at all leaves a visible sliver`);
  }
});

test("close games are toss-ups, not upsets, and the path sentence counts them that way", async () => {
  // make a few remaining games coin flips
  const close = JSON.parse(JSON.stringify(data));
  const pending = close.games.filter((g) => !g.completed);
  [0.52, 0.48, 0.55, 0.46].forEach((p, k) => { pending[k * 3].pHome = p; });
  close.exact = solve(close);
  let sawToss = false;
  for (const t of close.teams) {
    const { els } = render(close, "#" + t.abbr.toLowerCase());
    await settle();
    const html = els.team.innerHTML;
    const path = html.split("How the standings end")[0];
    if (!/Most likely path/.test(path)) continue;
    const upsetTags = (path.match(/class="tag ups">Upset · /g) || []).length;
    const tossDog = [...path.matchAll(/class="tag toss"[^>]*>Toss-up · (\d+)%/g)].filter((m) => +m[1] < 50).length;
    if (/class="tag toss"/.test(path)) sawToss = true;
    const sentence = text(html).match(/It needs [^.]*\./)[0];
    if (upsetTags === 0 && tossDog === 0) assert.match(sentence, /no upsets: every favorite wins/, t.abbr);
    else if (upsetTags === 0) assert.match(sentence, /no real upsets, but .*toss-up/, t.abbr);
    else assert.match(sentence, new RegExp(`needs (one|${upsetTags}) upsets?`), `${t.abbr}: ${sentence}`);
    if (tossDog > 0) assert.match(sentence, /toss-up/, `${t.abbr}: ${sentence}`);
  }
  assert.ok(sawToss, "toss-up tags appear");
});

test("intro reads 'Results through <date> with N games left'", async () => {
  const { els } = render(data, "#utah");
  await settle();
  assert.match(els.lede.textContent, /^Results through [A-Z][a-z]+ \d+ with 16 games left\. Pick a team/);
});

test("headline matches the exact odds", async () => {
  const i = data.teams.findIndex((t) => t.abbr === "TTU");
  const { els } = render(data, "#ttu");
  await settle();
  const shown = text(els.team.innerHTML).match(/([\d.]+)% to reach the title game/);
  assert.ok(shown);
  assert.ok(Math.abs(parseFloat(shown[1]) - data.exact.teams[i].p * 100) < 0.6);
});

test("an eliminated team says so, with no path", async () => {
  const t = data.exact.teams.find((x) => x.eliminated);
  assert.ok(t, "fixture has an eliminated team");
  const abbr = data.teams.find((x) => x.id === t.id).abbr.toLowerCase();
  const { els } = render(data, "#" + abbr);
  await settle();
  assert.match(text(els.team.innerHTML), /Eliminated/);
  assert.doesNotMatch(text(els.team.innerHTML), /Most likely path/);
});

test("a what-if switches to simulation and says so", async () => {
  const { els, handlers } = render(data, "#utah");
  await settle();
  const seg = { dataset: { k: "0", v: "1" } };
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? seg : null) } });
  assert.equal(els.locks.hidden, false);
  assert.match(text(els.locks.innerHTML), /simulated/);
  assert.match(text(els.team.innerHTML), /Your pick|Set by you/);
});

test("without exact data the page still works on simulation", async () => {
  const noExact = { ...data, exact: undefined };
  const { els } = render(noExact, "#utah");
  await settle();
  assert.match(els.methodText.textContent, /played out/);
  assert.match(text(els.team.innerHTML), /to reach the title game/);
});

test("skipped exact odds: simulation, and the footer says why", async () => {
  const skipped = { ...data, exact: { ...data.exact, teams: undefined, skipped: "would take about 900s, over the 180s budget" } };
  const { els } = render(skipped, "#utah");
  await settle();
  assert.match(els.methodText.textContent, /played out/);
  assert.match(text(els.foot.innerHTML), /Exact odds were skipped for this data: would take about 900s/);
});

test("what-if banner is hidden until a what-if is set, and the CSS honors hidden", async () => {
  const css = fs.readFileSync(path.join(root, "app.html"), "utf8");
  // .locks sets display: flex, which beats the browser's own [hidden] rule without this
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  const { els } = render(data, "#utah");
  await settle();
  assert.equal(els.locks.hidden, true);
  assert.equal(els.locks.innerHTML, "");
});

test("ESPN-supplied text is escaped", async () => {
  const evil = JSON.parse(JSON.stringify(data));
  evil.teams[0].name = '<img src=x onerror="alert(1)">';
  evil.teams[0].color = '"><script>';
  const { els } = render(evil, "#" + evil.teams[0].abbr.toLowerCase());
  await settle();
  assert.doesNotMatch(els.team.innerHTML + els.picker.innerHTML, /<img src=x|"><script>/);
});
