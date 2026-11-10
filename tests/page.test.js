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
    const sentence = text(html).match(/It needs [^.]*\./)[0];
    if (upsetTags === 0 && tossDog === 0) assert.match(sentence, /no upsets: every favorite wins/, t.abbr);
    else if (upsetTags === 0) assert.match(sentence, /no real upsets, but .*toss-up/, t.abbr);
    else assert.match(sentence, new RegExp(`needs (one|${upsetTags}) upsets?`), `${t.abbr}: ${sentence}`);
    if (tossDog > 0) assert.match(sentence, /toss-up/, `${t.abbr}: ${sentence}`);
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
    assert.match(path, /The percentage is ESPN's odds of that result\./);
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
  const m = head().match(/Odds of these (\d+) results: (\d+%|1 in [\d,.]+)\./);
  assert.ok(m, head());
  assert.equal(+m[1], keyRows(), "counts the rows shown above the folded games");
  // with a pick on a shown game, that game is left out of the odds
  const locked = els.team.innerHTML.match(/data-k="(\d+)" data-v="1"/)[1];
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: locked, v: "1" } } : null) } });
  assert.match(head(), /Odds of the other \d+ results?: /);
});

test("every path says how often its shown results are enough", async () => {
  let paths = 0;
  for (const t of data.teams) {
    const { els } = render(data, "#" + t.abbr.toLowerCase());
    await settle();
    const head = text((els.team.innerHTML.split("Most likely path")[1] || "").split("Week")[0]);
    if (!head) continue;
    paths++;
    assert.match(head, new RegExp(`If (they|it) happens?, ${t.short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (is in no matter how the other games go|gets in (\\d+%|under 1%) of the time; the rest comes down to games not shown)\\.`), `${t.abbr}: ${head}`);
  }
  assert.ok(paths > 5);
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
