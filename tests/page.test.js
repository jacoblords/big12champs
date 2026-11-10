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
// path-row odds cells: number, mark slot (! / !! / check), and the screen-reader note
const oddsCells = (html) => [...html.matchAll(/<span class="po( ups)?( set)?"><span class="n">([^<]+)<\/span><span class="x" aria-hidden="true">([^<]*)<\/span>(?:<span class="vh">, ([^<]+)<\/span>)?<\/span>/g)]
  .map((m) => ({ ups: !!m[1], set: !!m[2], n: m[3], pct: parseInt(m[3], 10), x: m[4], sr: m[5] || "" }));

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

test("rooting guide quotes ESPN's odds for the favorite, home or away", async () => {
  const d = JSON.parse(JSON.stringify(data));
  const abbr = Object.fromEntries(d.teams.map((t) => [t.id, t.abbr]));
  const pending = d.games.filter((g) => !g.completed);
  pending.forEach((g, k) => { g.pHome = k % 2 ? 0.3 : 0.7; });
  d.exact = solve(d);
  const seen = new Set();
  for (const t of d.teams) {
    const { els } = render(d, "#" + t.abbr.toLowerCase());
    await settle();
    for (const m of els.team.innerHTML.matchAll(/<span class="t">([^<]+?) at ([^<]+?)(?: · +their game)?<\/span><span class="s">Week \d+ · ESPN: ([^<]+) (\d+)%<\/span>/g)) {
      const g = pending.find((x) => abbr[x.away] === m[1] && abbr[x.home] === m[2]);
      assert.ok(g, `${m[1]} at ${m[2]}`);
      assert.equal(m[3], g.pHome < 0.5 ? m[1] : m[2], `${m[1]} at ${m[2]}`);
      assert.equal(m[4], "70", `${m[1]} at ${m[2]}`);
      seen.add(m[3] === m[1] ? "away" : "home");
    }
  }
  assert.deepEqual([...seen].sort(), ["away", "home"], "both kinds of favorite appear");
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
    const cells = oddsCells(path);
    const upsetTags = cells.filter((c) => c.ups).length;
    const tossDog = cells.filter((c) => c.sr === "toss-up" && c.pct < 50).length;
    if (cells.some((c) => c.sr === "toss-up")) sawToss = true;
    const sentence = html.match(/<dt>Needs<\/dt><dd>([^<]+)<\/dd>/)[1];
    if (upsetTags === 0 && tossDog === 0) assert.equal(sentence, "No upsets", t.abbr);
    else if (upsetTags === 0) assert.match(sentence, /^\d+ toss-ups? to the underdog$/, t.abbr);
    else assert.match(sentence, new RegExp(`^${upsetTags} upsets?`), `${t.abbr}: ${sentence}`);
    if (tossDog > 0) assert.match(sentence, new RegExp(`${tossDog} toss-ups?`), `${t.abbr}: ${sentence}`);
  }
  assert.ok(sawToss, "toss-up tags appear");
});

test("path rows: odds in one column, ! for upsets, !! for big upsets, a check beside your pick's odds", async () => {
  let sawUpset = false;
  for (const t of data.teams) {
    const { els } = render(data, "#" + t.abbr.toLowerCase());
    await settle();
    const path = els.team.innerHTML.split("How the standings end")[0];
    if (!/Most likely path/.test(path)) continue;
    assert.match(path, /Percentages are ESPN's odds of that result\./);
    const cells = oddsCells(path);
    assert.equal(cells.length, (path.match(/class="game/g) || []).length, `${t.abbr}: one odds cell per row`);
    assert.doesNotMatch(path, /<span class="po[^>]*title=/, "no hover text");
    for (const c of cells) {
      assert.match(c.n, /^(\d+%|<0\.1%|&lt;0\.1%)$/);
      if (c.pct < 25) assert.equal(c.x, "!!", `${t.abbr}: ${c.n} is a big upset`);
      else if (c.pct < 45) assert.equal(c.x, "!", `${t.abbr}: ${c.n} is an upset`);
      else assert.equal(c.x, "", `${t.abbr}: ${c.n} gets no mark`);
      assert.equal(c.ups, c.pct < 45);
      if (c.ups) sawUpset = true;
    }
  }
  assert.ok(sawUpset, "fixture paths include upsets");
  // a locked result keeps its odds and puts a check in the mark slot
  const { els, handlers } = render(data, "#ttu");
  await settle();
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: "0", v: "1" } } : null) } });
  const set = oddsCells(els.team.innerHTML.split("How the standings end")[0]).filter((c) => c.set);
  assert.equal(set.length, 1);
  assert.match(set[0].n, /^\d+%$/);
  assert.equal(set[0].x, "&#10003;");
  assert.doesNotMatch(els.team.innerHTML, /class="po[^"]*\bpick\b/, "not the picker card class");
});

test("path odds cover the results shown, not every remaining game", async () => {
  const { els, handlers } = render(data, "#ttu");
  await settle();
  const head = () => text(els.team.innerHTML.split("Most likely path")[1].split("Week")[0]);
  const keyRows = () => (els.team.innerHTML.split("How the standings end")[0].split('<details class="minor"')[0].match(/class="game/g) || []).length;
  assert.doesNotMatch(els.team.innerHTML, /full slate/);
  const m = els.team.innerHTML.match(/<dt>Odds of these (\d+) results<\/dt><dd>(\d+%|1 in [\d,.]+)<\/dd>/);
  assert.ok(m, head());
  assert.equal(+m[1], keyRows(), "counts the rows shown above the folded games");
  // with a pick on a shown game, that game is left out of the odds
  const locked = els.team.innerHTML.match(/data-k="(\d+)" data-v="1"/)[1];
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: locked, v: "1" } } : null) } });
  assert.match(els.team.innerHTML, /<dt>Odds of the other( \d+)? results?<\/dt>/);
});

test("a guaranteed path doesn't repeat that it's enough; a path that isn't says how often", async () => {
  let paths = 0;
  for (const t of data.teams) {
    const { els } = render(data, "#" + t.abbr.toLowerCase());
    await settle();
    const html = els.team.innerHTML;
    if (!/Most likely path/.test(html)) continue;
    paths++;
    assert.match(html, /guarantees .* a title-game spot/, t.abbr);
    assert.doesNotMatch(html, /<dt>If (?:they happen|it happens)<\/dt>/, `${t.abbr}: no reliability stat`);
    assert.doesNotMatch(html, /The rest comes down to games not shown\./, t.abbr);
  }
  assert.ok(paths > 5);
  // data without guaranteed paths (built before them): the likeliest finish, qualified when needed
  const old = JSON.parse(JSON.stringify(data));
  for (const t of old.exact.teams) delete t.need;
  let qualified = 0;
  for (const t of old.teams) {
    const { els } = render(old, "#" + t.abbr.toLowerCase());
    await settle();
    const html = els.team.innerHTML;
    if (!/Most likely path/.test(html)) continue;
    assert.doesNotMatch(html, /guarantees/, t.abbr);
    const m = html.match(/<dt>If (?:they happen|it happens)<\/dt><dd>((?:\d+%|Under 1%) of the time)<\/dd><\/div>/);
    assert.equal(!!m, /The rest comes down to games not shown\./.test(html), t.abbr);
    if (m) qualified++;
  }
  assert.ok(qualified > 0, "some old-style path isn't always enough");
});

test("intro reads 'Results through <date> with N games left'", async () => {
  const { els } = render(data, "#utah");
  await settle();
  assert.match(els.lede.textContent, /^Results through [A-Z][a-z]+ \d+ with 16 games left\. Pick a team/);
});

test("tiebreaks render as a sentence and a table, winner first, no bullets", async () => {
  let checked = 0;
  for (const t of data.teams) {
    const { els } = render(data, "#" + t.abbr.toLowerCase());
    await settle();
    const ends = els.team.innerHTML.split("How the standings end")[1];
    if (!ends) continue;
    assert.doesNotMatch(ends, /<ul class="why"/);
    for (const block of ends.split('<div class="tb">').slice(1)) {
      assert.match(text(block), /tied at \d+-\d+\. (\S.* gets the #[12] seed |.* drops? out .* start over\.).*Step [a-g]/);
      const cells = [...block.matchAll(/<span class="([^"]*)" role="cell">([^<]*)<\/span>/g)];
      if (!cells.length) continue;
      if (/drops? out/.test(text(block))) {
        // drop-out step: teams that stay are listed first, dropped teams after, crossed out
        const names = cells.filter((c, k) => k % 2 === 0).map((c) => /\bout\b/.test(c[1]));
        assert.equal(names[0], false, `${t.abbr}: a team that stays is listed first`);
        assert.ok(names.includes(true), `${t.abbr}: dropped teams are marked`);
        assert.deepEqual(names, names.slice().sort((a, b) => a - b), `${t.abbr}: dropped teams come last`);
      } else {
        assert.match(cells[0][1], /win/, `${t.abbr}: winner is the first row`);
      }
      checked++;
    }
  }
  assert.ok(checked > 0, "fixture paths include a tiebreak with a table");
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

test("what-ifs stay pinned at the top of the rooting guide, with the clear button", async () => {
  const { els, handlers } = render(data, "#utah");
  await settle();
  const pick = (k, v) => handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: String(k), v } } : null) } });
  pick(5, "1");
  pick(9, "0");
  const html = els.team.innerHTML;
  const guide = html.split("Who to root for")[1];
  const box = guide.indexOf('class="rg-picks"');
  const firstOther = guide.indexOf('class="rg-row', guide.indexOf("</div>", guide.lastIndexOf("Set by you")));
  assert.ok(box > -1 && box < firstOther, "picks box comes before the other games");
  assert.match(text(guide.slice(box)), /Your picks \(2\) Clear all/);
  assert.equal((guide.slice(box).split('class="rg-picks"')[1].match(/Set by you/g) || []).length, 2);
  assert.doesNotMatch(els.locks.innerHTML, /clearLocks/, "the top banner no longer has the button");
  handlers.click({ target: { id: "clearLocks", closest: () => null } });
  assert.doesNotMatch(els.team.innerHTML, /rg-picks/);
  assert.equal(els.locks.hidden, true);
});

test("one click sets the selected team to win out, and again undoes it", async () => {
  const { els, handlers } = render(data, "#ttu");
  await settle();
  const ttu = data.teams.findIndex((t) => t.abbr === "TTU");
  const remaining = data.games.filter((g) => !g.completed && (g.home === data.teams[ttu].id || g.away === data.teams[ttu].id)).length;
  assert.ok(remaining > 0);
  assert.match(els.team.innerHTML, /id="winOut"[^>]*aria-pressed="false"[^>]*>What if Texas Tech wins out\?/);
  const clickWinOut = () => handlers.click({ target: { id: "", closest: (sel) => (sel === "#winOut" ? { dataset: { team: String(ttu) } } : null) } });
  clickWinOut();
  const box = els.team.innerHTML.split('class="rg-picks"')[1];
  assert.ok(box, "picks box appears");
  assert.equal((box.match(/Set by you: Texas Tech wins/g) || []).length, remaining);
  assert.match(els.team.innerHTML, /id="winOut"[^>]*aria-pressed="true"[^>]*>&#10003; Texas Tech wins out<\/button>/);
  clickWinOut();
  assert.doesNotMatch(els.team.innerHTML, /rg-picks/);
  assert.equal(els.locks.hidden, true);
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

test("dark-background logos are included and swapped by theme", async () => {
  const withLogos = JSON.parse(JSON.stringify(data));
  const png = "data:image/png;base64,iVBORw0KGgo=";
  withLogos.teams.forEach((t) => { t.logo = png; t.logoDark = png; });
  withLogos.teams[1].logoDark = null; // a team without a dark version falls back to the regular logo
  const { els } = render(withLogos, "#utah");
  await settle();
  assert.match(els.picker.innerHTML, /<img class="logo-light" src="data:image\/png;base64,[^"]+" alt=""><img class="logo-dark"/);
  const css = fs.readFileSync(path.join(root, "app.html"), "utf8");
  assert.match(css, /\.logo-dark \{ display: none; \}/);
  assert.match(css, /prefers-color-scheme: dark[\s\S]*?\.logo-light \{ display: none; \}/);
  const second = withLogos.teams[1].abbr;
  const card = els.picker.innerHTML.split('<button').find((b) => b.includes(`>${second}<`));
  assert.doesNotMatch(card, /logo-dark/, "no dark logo: plain image only");
  // a non-PNG value is never rendered
  withLogos.teams[0].logoDark = 'javascript:alert(1)';
  const r2 = render(withLogos, "#utah");
  await settle();
  assert.doesNotMatch(r2.els.picker.innerHTML, /javascript:/);
});

test("ESPN-supplied text is escaped", async () => {
  const evil = JSON.parse(JSON.stringify(data));
  evil.teams[0].name = '<img src=x onerror="alert(1)">';
  evil.teams[0].color = '"><script>';
  const { els } = render(evil, "#" + evil.teams[0].abbr.toLowerCase());
  await settle();
  assert.doesNotMatch(els.team.innerHTML + els.picker.innerHTML, /<img src=x|"><script>/);
});

// ---- leagues: header nav, the SEC, ACC and Big Ten pages ----
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const LEAGUES = [
  { id: "big12", name: "Big 12", path: "", group: 4, logo: PNG, logoDark: PNG, sponsor: { name: "Monster Energy", logo: PNG } },
  { id: "sec", name: "SEC", path: "sec/", group: 8, logo: PNG, logoDark: PNG },
  { id: "acc", name: "ACC", path: "acc/", group: 1, logo: PNG, logoDark: PNG },
  { id: "big10", name: "Big Ten", path: "big10/", group: 5, logo: PNG, logoDark: PNG },
];
// 2025 SEC with its final week of conference games left to play: a small exact enumeration
function secFinalWeek() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "final-sec-2025.json"), "utf8"));
  for (const g of d.games) if (g.week === 14 && g.conf) Object.assign(g, { completed: false, winner: null, pHome: 0.6 });
  d.leagues = LEAGUES;
  d.exact = solve(d);
  return d;
}

test("header: a quiet league switch and the season above, the league's logo leading the title", async () => {
  const { els } = render({ ...data, leagues: LEAGUES }, "");
  await settle();
  const nav = els.leagues.innerHTML;
  assert.match(text(nav), /^\s*Big 12 SEC ACC Big Ten\s*$/);
  assert.equal(els.season.textContent, "2026 season");
  const link = (re) => nav.match(re)[0];
  const big12 = link(/<a href="\.\/" aria-current="page"[^>]*>[\s\S]*?<\/a>/);
  const sec = link(/<a href="sec\/"[^>]*>[\s\S]*?<\/a>/);
  const acc = link(/<a href="acc\/"[^>]*>[\s\S]*?<\/a>/);
  const big10 = link(/<a href="big10\/"[^>]*>[\s\S]*?<\/a>/);
  assert.match(text(big12), /Big 12/);
  assert.match(text(sec), /SEC/);
  assert.match(text(acc), /ACC/);
  assert.match(text(big10), /Big Ten/);
  // each league's logo (light and dark) in the switch; no sponsor there
  for (const a of [big12, sec, acc, big10]) assert.equal((a.match(/class="logo-(light|dark)"/g) || []).length, 2);
  assert.doesNotMatch(nav, /sponsor/);
  // the title: Monster's claw, then the Big 12 logo, then the name
  const lockup = els.lockup.innerHTML;
  assert.match(lockup, /<img class="sponsor" src="data:image\/png;base64,[^"]+" alt="Monster Energy"[^>]*>.*class="logo-light"/s);
  assert.equal(els.lockup.hidden, false);
  assert.equal(els.title.textContent, "Big 12 Title Paths");
});

test("header: no league logos in the data, no empty logo block", async () => {
  const { els } = render(data, "");
  await settle();
  assert.equal(els.lockup.hidden, true);
  assert.equal(els.title.textContent, "Big 12 Title Paths");
});

test("SEC page: links back up a level, SEC wording, numbered SEC steps, SEC sources", async () => {
  const sec = secFinalWeek();
  const { els } = render(sec, "#ala");
  await settle();
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\.\/"[^>]*>[\s\S]*?<\/a>/)[0]), /Big 12/);
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\/" aria-current="page"[^>]*>[\s\S]*?<\/a>/)[0]), /SEC/);
  assert.equal(els.title.textContent, "SEC Title Paths");
  assert.doesNotMatch(els.lockup.innerHTML, /sponsor/, "Monster sponsors the Big 12, not the SEC");
  assert.match(els.lockup.innerHTML, /class="logo-light"/);
  assert.match(text(els.team.innerHTML), /Alabama Crimson Tide \d+-\d+ SEC/);
  assert.match(els.methodText.textContent, /official SEC tiebreakers/);
  const rules = text(els.rules.innerHTML);
  assert.match(rules, /The six steps/);
  assert.match(rules, /Capped relative total scoring margin/);
  assert.doesNotMatch(rules, /Total wins/);
  assert.match(rules, /seeded by the two-team steps/);
  assert.match(els.foot.innerHTML, /secsports\.com/);
  assert.match(els.foot.innerHTML, /groups=8/);
  assert.doesNotMatch(els.foot.innerHTML + rules, /Big 12/);
});

test("SEC tiebreaks show the league's step numbers, and say who got in before who is #1", async () => {
  const sec = secFinalWeek();
  let sawSpot = false, sawNumber = false;
  for (const t of sec.teams) {
    const { els } = render(sec, "#" + t.abbr.toLowerCase());
    await settle();
    const html = els.team.innerHTML;
    assert.doesNotMatch(html, /Step [a-g]</, t.abbr);
    if (/Step [1-6]</.test(html)) sawNumber = true;
    if (/gets a title-game spot/.test(text(html))) sawSpot = true;
  }
  assert.ok(sawNumber, "some path shows a numbered step");
  assert.ok(sawSpot, "some path picks the two teams before seeding them");
});

// The 2026 ACC snapshot with week 11 decided: 14 games left. Five teams play eight conference games
// and twelve play nine. Favorites win except Duke at Miami and Georgia Tech at Clemson, which puts a
// tie across schedule lengths on a likeliest path (Duke 6-3 and Clemson 5-3, on SMU's).
function accLateSeason() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "acc-season-2026-11-09.json"), "utf8"));
  const ab = Object.fromEntries(d.teams.map((t) => [t.id, t.abbr]));
  const upset = new Set(["DUKE@MIA", "GT@CLEM"]);
  for (const g of d.games) {
    if (g.completed || g.week !== 11) continue;
    const homeWins = (g.pHome >= 0.5) !== upset.has(`${ab[g.away]}@${ab[g.home]}`);
    Object.assign(g, { completed: true, winner: homeWins ? g.home : g.away });
  }
  d.leagues = LEAGUES;
  d.exact = solve(d);
  return d;
}

test("ACC page: its own steps, the tied-team definition, FPI standing in, the ACC's policy", async () => {
  const acc = accLateSeason();
  const { els } = render(acc, "#mia");
  await settle();
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\.\/"[^>]*>[\s\S]*?<\/a>/)[0]), /Big 12/);
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\.\/sec\/"[^>]*>[\s\S]*?<\/a>/)[0]), /SEC/);
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\/" aria-current="page"[^>]*>[\s\S]*?<\/a>/)[0]), /ACC/);
  assert.equal(els.title.textContent, "ACC Title Paths");
  assert.doesNotMatch(els.lockup.innerHTML, /sponsor/);
  assert.match(text(els.team.innerHTML), /Miami Hurricanes \d+-\d+ ACC/);
  assert.match(els.methodText.textContent, /official ACC tiebreakers/);
  const rules = text(els.rules.innerHTML);
  assert.match(rules, /The three steps/);
  assert.match(rules, /Team Success Ranking/);
  assert.match(rules, /Who counts as tied/);
  assert.match(rules, /Working down/);
  assert.match(rules, /ESPN's FPI in its place/);
  assert.doesNotMatch(rules, /Total wins|Common opponents|Walk the standings/);
  assert.match(els.foot.innerHTML, /ACC_Football_Tiebreaker_Policy/);
  assert.match(els.foot.innerHTML, /groups=1/);
  assert.doesNotMatch(els.foot.innerHTML + rules, /Big 12|SEC/);
});

test("ACC tiebreaks: numbered steps, and teams tied on different schedules are named with their records", async () => {
  const acc = accLateSeason();
  let sawNumber = false;
  for (const t of acc.teams) {
    const { els } = render(acc, "#" + t.abbr.toLowerCase());
    await settle();
    const html = els.team.innerHTML;
    assert.doesNotMatch(html, /Step [a-g4-9]</, t.abbr);
    if (/Step [1-3]</.test(html)) sawNumber = true;
  }
  assert.ok(sawNumber, "some path shows a numbered step");
  // SMU's likeliest path: Duke 6-3 over nine games and Clemson 5-3 over eight are tied on losses
  const { els } = render(acc, "#smu");
  await settle();
  const say = text(els.team.innerHTML);
  assert.match(say, /Duke \(6-3\) and Clemson \(5-3\) count as tied: three losses each, over nine and eight conference games\. Clemson wins this tie by beating Duke, and moves on\./);
  // working downward: Clemson then meets the 5-4 teams it's tied with on wins
  assert.match(say, /Four teams tied \(SMU 5-4, Clemson 5-3, Pitt 5-4, Virginia Tech 5-4\)\. SMU gets the #2 seed/);
});

// The 2026 Big Ten snapshot with weeks 11 and 12 decided by ESPN's favorites: the last nine
// conference games left (the full snapshot has 27, too many for exact odds).
function big10LateSeason() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "big10-season-2026-11-10.json"), "utf8"));
  for (const g of d.games) if (!g.completed && g.week <= 12) Object.assign(g, { completed: true, winner: g.pHome >= 0.5 ? g.home : g.away });
  d.leagues = LEAGUES;
  d.exact = solve(d);
  return d;
}

test("Big Ten page: its own name, six numbered steps, the rating stand-in, the Big Ten's policy", async () => {
  const b10 = big10LateSeason();
  assert.equal(b10.exact.games, 9);
  const { els } = render(b10, "#osu");
  await settle();
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\.\/"[^>]*>[\s\S]*?<\/a>/)[0]), /Big 12/);
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\.\/acc\/"[^>]*>[\s\S]*?<\/a>/)[0]), /ACC/);
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\/" aria-current="page"[^>]*>[\s\S]*?<\/a>/)[0]), /Big Ten/);
  assert.equal(els.title.textContent, "Big Ten Title Paths");
  assert.doesNotMatch(els.lockup.innerHTML, /sponsor/);
  assert.match(text(els.team.innerHTML), /Ohio State Buckeyes \d+-\d+ Big Ten/);
  assert.match(els.methodText.textContent, /official Big Ten tiebreakers/);
  const rules = text(els.rules.innerHTML);
  assert.match(rules, /The six steps/);
  assert.match(rules, /Opponents' winning percentage/);
  assert.match(rules, /SportSource Analytics Team Rating Score/);
  assert.match(rules, /go on to the next step, not back to step 1/);
  assert.match(rules, /seeded by the two-team steps/);
  assert.doesNotMatch(rules, /Total wins/);
  assert.match(els.foot.innerHTML, /2024_Big_Ten_Football_Tiebreaker/);
  assert.match(els.foot.innerHTML, /groups=5/);
  assert.doesNotMatch(els.foot.innerHTML + rules, /Big 12|SEC|ACC/);
});

test("Big Ten tiebreaks show the league's step numbers", async () => {
  const b10 = big10LateSeason();
  let sawNumber = false;
  for (const t of b10.teams) {
    const { els } = render(b10, "#" + t.abbr.toLowerCase());
    await settle();
    const html = els.team.innerHTML;
    assert.doesNotMatch(html, /Step [a-g7-9]</, t.abbr);
    if (/Step [1-6]</.test(html)) sawNumber = true;
  }
  assert.ok(sawNumber, "some path shows a numbered step");
});
