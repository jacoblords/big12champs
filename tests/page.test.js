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

function render(data, hash, extra) {
  const els = {};
  const handlers = {};
  const document = {
    getElementById: (id) => (els[id] ||= {
      id, innerHTML: "", textContent: "", hidden: false, attrs: id === "page" ? { "aria-busy": "true" } : {}, scrollIntoView() {},
      setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
    }),
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  const location = { hash: hash || "" };
  const sandbox = {
    document, window: { addEventListener: (type, fn) => { handlers["window:" + type] = fn; } }, location,
    history: { replaceState: (_, __, url) => { location.hash = url; } },
    fetch: async () => ({ ok: true, json: async () => data }), console, Math, Date, JSON, Promise,
    // unref'd, so a page's own timers (the gameday page's minute check) don't hold the test run open
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; }, clearTimeout,
    ...extra,
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
    for (const m of els.team.innerHTML.matchAll(/<span class="t">(?:<span class="me">(?:<img[^>]*>)+<\/span>)?([^<]+?) at (?:<span class="me">(?:<img[^>]*>)+<\/span>)?([^<]+?)<\/span><span class="s">(?:Week \d+ · )?ESPN: ([^<]+) (\d+)%<\/span>/g)) {
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
  assert.match(text(els.team.innerHTML), /Your picks \(1\)/);
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
  const firstOther = guide.indexOf('class="rg-row', guide.indexOf("</div>", guide.lastIndexOf("&#10003; ")));
  assert.ok(box > -1 && box < firstOther, "picks box comes before the other games");
  assert.match(text(guide.slice(box)), /Your picks \(2\) Clear all/);
  assert.equal((guide.slice(box).split('class="rg-picks"')[1].match(/aria-pressed="true"[^>]*>&#10003; /g) || []).length, 2, "each pick's pressed button is checked");
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
  assert.equal((box.match(/aria-pressed="true" title="Texas Tech wins"[^>]*>&#10003; TTU</g) || []).length, remaining);
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

test("the page stays hidden until it is rendered, and shows even when the data fails to load", async () => {
  const css = fs.readFileSync(path.join(root, "app.html"), "utf8");
  assert.match(css, /<div class="wrap" id="page" aria-busy="true">/);
  assert.match(css, /\.wrap\[aria-busy="true"\] \{ visibility: hidden; \}/, "hidden but laid out, so its fonts load");
  const { els, sandbox } = render(data, "#utah");
  assert.equal(sandbox.document.getElementById("page").attrs["aria-busy"], "true", "as the HTML starts");
  await new Promise((r) => setTimeout(r, 600)); // no document.fonts here: the capped wait
  assert.match(text(els.team.innerHTML), /Utah/);
  assert.equal(els.page.attrs["aria-busy"], undefined);
  const broken = render(data, "#utah", { fetch: async () => ({ ok: false, status: 503 }) });
  await new Promise((r) => setTimeout(r, 600));
  assert.match(broken.els.lede.textContent, /Couldn't load the standings data \(HTTP 503\)/);
  assert.equal(broken.els.page.attrs["aria-busy"], undefined);
});

test("a pick answers at once and recomputes after the frame, folding quick clicks into one", async () => {
  const frames = [];
  const { els, handlers, sandbox } = render(data, "#ttu", { requestAnimationFrame: (fn) => frames.push(fn) });
  await settle();
  let sims = 0;
  const mainSims = sandbox.B12.mainSims;
  sandbox.B12.mainSims = (...a) => { sims++; return mainSims(...a); };
  const btn = (k, v) => ({ dataset: { k: String(k), v }, setAttribute(a, x) { this[a] = x; } });
  const pressed = btn(0, "1"), other = btn(0, "0");
  const seg = { querySelectorAll: () => [pressed, other] };
  pressed.closest = other.closest = (sel) => (sel === ".seg" ? seg : null);
  const click = (b) => handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? b : null) } });
  const before = els.team.innerHTML;
  click(pressed);
  click(btn(1, "0"));
  assert.equal(sims, 0, "no simulation inside the click");
  assert.equal(els.team.innerHTML, before, "the full render waits for the frame");
  assert.equal(pressed["aria-pressed"], "true");
  assert.equal(other["aria-pressed"], "false");
  assert.equal(els.team.attrs["aria-busy"], "true");
  assert.match(sandbox.location.hash, /&picks=\w+\.\w+/, "the link updates at once");
  assert.equal(frames.length, 1, "one frame requested for both clicks");
  assert.match(els.calc.textContent, /Simulating 40,000 seasons/, "says what it is doing");
  frames[0]();
  await settle();
  assert.equal(sims, 1, "two clicks, one run, for where they ended up");
  assert.equal(els.team.attrs["aria-busy"], undefined);
  assert.equal(els.calc.textContent, "");
  assert.match(els.team.innerHTML, /class="rg-picks"/);
});

// A stand-in for the browser's Worker: runs the blob the page builds in its own context, and
// passes every message through structuredClone, as the browser does.
class FakeWorker {
  constructor(url) {
    const blob = require("buffer").resolveObjectURL(url);
    this.ready = blob.text().then((src) => {
      const w = vm.createContext({ console, Math, JSON });
      w.self = w;
      w.postMessage = (m) => { const c = structuredClone(m); setTimeout(() => this.onmessage({ data: c })); };
      vm.runInContext(src, w);
      this.w = w;
    });
    FakeWorker.made++;
  }
  postMessage(m) { const c = structuredClone(m); this.ready.then(() => this.w.onmessage({ data: c })); }
  terminate() {}
}
FakeWorker.made = 0;
function renderWithWorker(d, hash) {
  // the page finds the engine's script among document.scripts
  const r = render(d, hash, { Worker: FakeWorker, Blob, URL });
  r.sandbox.document.scripts = pageScripts.map((textContent) => ({ src: "", textContent }));
  return r;
}
const until = async (cond) => { for (let t = 0; t < 400 && !cond(); t++) await new Promise((r) => setTimeout(r, 25)); assert.ok(cond(), "timed out"); };

test("simulated odds come from the worker, matching what the page computes itself", async () => {
  const noExact = { ...data, exact: undefined };
  const made = FakeWorker.made;
  const w = renderWithWorker(noExact, "#ttu");
  await until(() => w.els.team && /to reach the title game/.test(w.els.team.innerHTML));
  assert.equal(FakeWorker.made, made + 1, "the page started a worker");
  const here = render(noExact, "#ttu");
  await settle();
  assert.equal(w.els.team.innerHTML, here.els.team.innerHTML);
  assert.equal(w.els.picker.innerHTML, here.els.picker.innerHTML);
  // a pick: the click returns at once, the worker answers, the view matches a straight-through run
  const pickIt = (h) => h.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: "2", v: "0" } } : null) } });
  const shown = w.els.team.innerHTML;
  pickIt(w.handlers);
  assert.equal(w.els.team.innerHTML, shown, "nothing computed inside the click");
  assert.ok(w.els.calc.textContent, "a status line while it runs");
  await until(() => w.els.team.innerHTML !== shown);
  pickIt(here.handlers);
  assert.equal(w.els.team.innerHTML, here.els.team.innerHTML);
  assert.equal(w.els.calc.textContent, "");
});

test("one more pick shows estimated odds at once, then the full run's", async () => {
  const noExact = { ...data, exact: undefined };
  const frames = [];
  const { els, handlers } = render(noExact, "#ttu", { requestAnimationFrame: (fn) => frames.push(fn) });
  await settle();
  while (frames.length) frames.shift()(); // the first view's run
  await settle();
  const pills = () => [...els.picker.innerHTML.matchAll(/id="pick-(\w+)"[\s\S]*?<span class="odds([^"]*)"><i[^>]*><\/i><b>([^<]+)<\/b>/g)].map((m) => ({ abbr: m[1], est: / est/.test(m[2]), label: m[3] }));
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: "2", v: "0" } } : null) } });
  const est = pills();
  assert.ok(est.length && est.every((p) => p.est), "every pill marked as an estimate");
  assert.match(els.calc.textContent, /Estimate shown, refining/);
  assert.equal(els.picker.attrs["aria-busy"], undefined, "fresh estimates aren't dimmed");
  assert.equal(els.team.attrs["aria-busy"], "true", "the rest of the view is");
  frames.shift()();
  await settle();
  const full = pills();
  assert.ok(full.every((p) => !p.est));
  for (const f of full) {
    const e = est.find((x) => x.abbr === f.abbr);
    const n = (x) => (/^\d/.test(x) ? parseFloat(x) : x === "0%" ? 0 : null);
    if (n(e.label) != null && n(f.label) != null) assert.ok(Math.abs(n(e.label) - n(f.label)) <= 3, `${f.abbr}: estimate ${e.label} vs ${f.label}`);
  }
  // undoing a pick (or several at once) has no estimate: the picker dims instead
  handlers.click({ target: { id: "clearLocks", closest: () => null } });
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: "3", v: "1" } } : null) } });
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: "4", v: "1" } } : null) } });
  assert.equal(els.picker.attrs["aria-busy"], "true");
});

test("from exact odds, the first pick shows each team's exact odds given that result at once", async () => {
  const frames = [];
  const { els, handlers, sandbox } = render(data, "#ttu", { requestAnimationFrame: (fn) => frames.push(fn) });
  await settle();
  while (frames.length) frames.shift()();
  await settle();
  const pills = () => Object.fromEntries([...els.picker.innerHTML.matchAll(/id="pick-(\w+)"[\s\S]*?<span class="odds([^"]*)"><i[^>]*><\/i><b>([^<]+)<\/b>/g)].map((m) => [m[1], { est: / est/.test(m[2]), label: m[3] }]));
  const k = 2;
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: String(k), v: "0" } } : null) } });
  const est = pills();
  assert.equal(Object.keys(est).length, data.teams.length);
  data.teams.forEach((t, i) => {
    assert.ok(est[t.abbr].est, t.abbr + " marked as an estimate");
    // the label the picker would print for the exact conditional odds
    const p = data.exact.teams[i].games[k].pA;
    const want = p <= 0 ? "0%" : p >= 1 ? "100%" : p < 0.001 ? "&lt;0.1%" : p > 0.999 ? ">99.9%" : (p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0) + "%";
    assert.equal(est[t.abbr].label, want, t.abbr);
  });
  assert.match(els.calc.textContent, /Estimate shown, refining/);
  assert.equal(els.picker.attrs["aria-busy"], undefined, "fresh numbers aren't dimmed");
  while (frames.length) frames.shift()();
  await settle();
  const full = pills();
  for (const t of data.teams) {
    assert.ok(!full[t.abbr].est);
    const n = (x) => (x === "0%" ? 0 : /^\d/.test(x) ? parseFloat(x) : null);
    if (n(est[t.abbr].label) != null && n(full[t.abbr].label) != null)
      assert.ok(Math.abs(n(est[t.abbr].label) - n(full[t.abbr].label)) <= 2, `${t.abbr}: exact ${est[t.abbr].label} vs simulated ${full[t.abbr].label}`);
  }
  // exact data from before per-game odds existed: no estimate, the picker dims instead
  const old = JSON.parse(JSON.stringify(data));
  old.exact.teams.forEach((t) => { delete t.games; });
  const frames2 = [];
  const r = render(old, "#ttu", { requestAnimationFrame: (fn) => frames2.push(fn) });
  await settle();
  while (frames2.length) frames2.shift()();
  await settle();
  r.handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: "2", v: "0" } } : null) } });
  assert.equal(r.els.picker.attrs["aria-busy"], "true");
});

test("a simulated league's no-pick view is precomputed with the data, and matches the page's own", async () => {
  const { presim, inputsKey } = require("../exact.js");
  const noExact = { ...data, exact: { skipped: "too many" } };
  const withSim = { ...noExact, sim: JSON.parse(JSON.stringify(presim(noExact, inputsKey(noExact)))) };
  for (const abbr of ["utah", "ttu", data.teams[data.teams.length - 1].abbr.toLowerCase()]) {
    const pre = render(withSim, "#" + abbr);
    let runs = 0;
    const mainSims = pre.sandbox.B12.mainSims;
    pre.sandbox.B12.mainSims = (...a) => { runs++; return mainSims(...a); };
    await settle();
    assert.equal(runs, 0, abbr + ": nothing simulated");
    const live = render(noExact, "#" + abbr);
    await settle();
    assert.equal(pre.els.team.innerHTML, live.els.team.innerHTML, abbr);
    assert.equal(pre.els.picker.innerHTML, live.els.picker.innerHTML, abbr);
  }
  // with a worker and no team in the link: straight to the leader, nothing to compute
  const viaWorker = renderWithWorker(withSim, "");
  await until(() => viaWorker.els.team && /to reach the title game/.test(viaWorker.els.team.innerHTML));
  assert.match(text(viaWorker.els.team.innerHTML), /Utah Utes 7-0 Big 12/);
  // data whose games no longer match is ignored
  const stale = JSON.parse(JSON.stringify(withSim));
  stale.sim.gameIds[0] = "nope";
  const r = render(stale, "#utah");
  await settle();
  assert.match(text(r.els.team.innerHTML), /to reach the title game/);
});

test("a link cut short mid-escape opens the page on the default team", async () => {
  const { els, handlers, sandbox } = render(data, "#utah%");
  await settle();
  assert.doesNotMatch(els.lede.textContent, /Couldn't load/);
  assert.match(text(els.team.innerHTML), /Utah Utes 7-0 Big 12/, "the conference leader, as with no team");
  sandbox.location.hash = "#ttu%E";
  assert.doesNotThrow(() => handlers["window:hashchange"]());
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
  // the hosted page's logo files (page-data.json), from the root or a league folder; nothing else
  const files = JSON.parse(JSON.stringify(data));
  files.teams.forEach((t, k) => { t.logo = "logos/0123456789abcdef.png"; t.logoDark = "../logos/fedcba9876543210.png"; });
  files.teams[0].logo = "https://evil.example/logos/0123456789abcdef.png";
  files.teams[0].logoDark = "logos/x.png";
  const r3 = render(files, "#utah");
  await settle();
  assert.match(r3.els.picker.innerHTML, /<img class="logo-light" src="logos\/0123456789abcdef\.png" alt=""><img class="logo-dark" src="\.\.\/logos\/fedcba9876543210\.png"/);
  assert.doesNotMatch(r3.els.picker.innerHTML, /evil\.example|logos\/x\.png/);
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
  { id: "pac12", name: "Pac-12", path: "pac12/", group: 9, logo: PNG, logoDark: PNG },
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
  assert.match(text(nav), /^\s*Big 12 SEC ACC Big Ten Pac-12\s*$/);
  assert.equal(els.season.textContent, "2026 season");
  const link = (re) => nav.match(re)[0];
  const big12 = link(/<a href="\.\/" aria-current="page"[^>]*>[\s\S]*?<\/a>/);
  const sec = link(/<a href="sec\/"[^>]*>[\s\S]*?<\/a>/);
  const acc = link(/<a href="acc\/"[^>]*>[\s\S]*?<\/a>/);
  const big10 = link(/<a href="big10\/"[^>]*>[\s\S]*?<\/a>/);
  const pac12 = link(/<a href="pac12\/"[^>]*>[\s\S]*?<\/a>/);
  assert.match(text(big12), /Big 12/);
  assert.match(text(sec), /SEC/);
  assert.match(text(acc), /ACC/);
  assert.match(text(big10), /Big Ten/);
  assert.match(text(pac12), /Pac-12/);
  // each league's logo (light and dark) in the switch; no sponsor there
  for (const a of [big12, sec, acc, big10, pac12]) assert.equal((a.match(/class="logo-(light|dark)"/g) || []).length, 2);
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

// Every conference game played (the 2026 snapshot finished by ESPN's favorites): final standings,
// with no odds, paths or rooting guide left to show.
test("season over: final standings and seeds, no odds or rooting guide", async () => {
  const d = reducedSeason();
  for (const g of d.games) if (!g.completed) Object.assign(g, { completed: true, winner: g.pHome >= 0.5 ? g.home : g.away, pHome: null });
  d.exact = solve(d);
  const seeds = d.exact.teams.map((t, k) => [t.p, k]).filter(([p]) => p === 1).map(([, k]) => d.teams[k].abbr);
  assert.equal(seeds.length, 2);
  let sawOut = false;
  for (const t of d.teams) {
    const { els } = render(d, "#" + t.abbr.toLowerCase());
    await settle();
    const team = text(els.team.innerHTML);
    assert.match(els.lede.textContent, /^Final standings: every Big 12 game is played, the last on November \d+\./);
    assert.equal(els.method.hidden, true);
    assert.match(team, /Final standings Every conference game is played\./);
    assert.match(team, /How the standings end #1 /);
    assert.doesNotMatch(team, /Who to root for|games? left|Most likely path|Eliminated|undefined|NaN/);
    const picker = text(els.picker.innerHTML);
    assert.match(picker, /#1/);
    assert.match(picker, /#2/);
    assert.doesNotMatch(picker, /%/);
    if (seeds.includes(t.abbr)) assert.match(team, /#[12] seed in the title game .* is the #[12] seed and plays /);
    else { sawOut = true; assert.match(team, /Out of the title game .* play for the title\./); }
  }
  assert.ok(sawOut);
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
  assert.match(els.foot.innerHTML, /href="https:\/\/bigten\.org\/sports\/2026\/11\/10\/FB_1110261447\.aspx"/);
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

// The 2026 Pac-12 snapshot (Nov. 13): eight teams in a round robin, eight conference games left,
// so exact odds always; week 13's flex games are in the data but not conference games.
function pac12Season() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pac12-season-2026-11-13.json"), "utf8"));
  d.leagues = LEAGUES;
  d.exact = solve(d);
  return d;
}

test("Pac-12 page: its own name, six numbered steps, the round robin, the flex week, the Pac-12's policy", async () => {
  const p12 = pac12Season();
  assert.equal(p12.exact.games, 8);
  const { els } = render(p12, "#bois");
  await settle();
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\.\/"[^>]*>[\s\S]*?<\/a>/)[0]), /Big 12/);
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\.\/big10\/"[^>]*>[\s\S]*?<\/a>/)[0]), /Big Ten/);
  assert.match(text(els.leagues.innerHTML.match(/<a href="\.\/" aria-current="page"[^>]*>[\s\S]*?<\/a>/)[0]), /Pac-12/);
  assert.equal(els.title.textContent, "Pac-12 Title Paths");
  assert.doesNotMatch(els.lockup.innerHTML, /sponsor/);
  assert.match(text(els.team.innerHTML), /Boise State Broncos \d+-\d+ Pac-12/);
  assert.match(els.methodText.textContent, /official Pac-12 tiebreakers/);
  const rules = text(els.rules.innerHTML);
  assert.match(rules, /The six steps/);
  assert.match(rules, /full round robin of seven conference games/);
  assert.match(rules, /flex/);
  assert.match(rules, /head-to-head for every two-team tie/);
  assert.match(rules, /SportSource Analytics Team Rating Score/);
  assert.doesNotMatch(rules, /Total wins|seeded by the two-team steps/);
  assert.match(els.foot.innerHTML, /href="https:\/\/pac-12\.com\/news\/2026\/9\/3\//);
  assert.match(els.foot.innerHTML, /groups=9/);
  assert.doesNotMatch(els.foot.innerHTML + rules, /Big 12|SEC|ACC|Big Ten/);
});

test("Pac-12 tiebreaks show the league's step numbers", async () => {
  const p12 = pac12Season();
  for (const t of p12.teams) {
    const { els } = render(p12, "#" + t.abbr.toLowerCase());
    await settle();
    assert.doesNotMatch(els.team.innerHTML, /Step [a-g7-9]</, t.abbr);
  }
});

test("the link carries the team, what-if picks and order, and opening it restores them", async () => {
  const { els, handlers, sandbox } = render(data, "#utah");
  await settle();
  const pick = (k, v) => handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: String(k), v } } : null) } });
  pick(5, "1");
  pick(9, "0");
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".rg-sort button" ? { dataset: { sort: "swing" } } : null) } });
  const link = sandbox.location.hash;
  const pending = data.games.filter((g) => !g.completed);
  assert.match(link, /^#utah&picks=\d+[ha]\.\d+[ha]&sort=swing$/);
  const before = els.team.innerHTML;

  const again = render(data, link);
  await settle();
  assert.equal(again.els.team.innerHTML, before, "same view from the link");
  assert.equal(again.els.locks.hidden, false);
  assert.equal(again.sandbox.location.hash, link);
  assert.ok(pending.length > 9);

  // clearing the picks takes them out of the link
  handlers.click({ target: { id: "clearLocks", closest: () => null } });
  assert.equal(sandbox.location.hash, "#utah&sort=swing");
});

test("a link's picks for games already played, or unknown games, are dropped", async () => {
  const { els, sandbox } = render(data, "#utah&picks=999h.notagamea&sort=bogus");
  await settle();
  assert.equal(els.locks.hidden, true);
  assert.equal(sandbox.location.hash, "#utah");
});

test("an old team-only link still works, and a new link pasted into an open page applies", async () => {
  const { els, handlers, sandbox } = render(data, "#ttu");
  await settle();
  assert.match(text(els.team.innerHTML), /Texas Tech/);
  const g = data.games.find((x) => !x.completed);
  sandbox.location.hash = `#utah&picks=${g.id}a`;
  handlers["window:hashchange"]();
  assert.match(text(els.team.innerHTML), /Utah Utes/);
  assert.equal(els.locks.hidden, false);
});

test("a malformed link falls back to the default team, and the address bar says so", async () => {
  const { els, handlers, sandbox } = render(data, "#zzz");
  await settle();
  assert.match(text(els.team.innerHTML), /Utah Utes 7-0 Big 12/);
  assert.equal(sandbox.location.hash, "#utah");
  // typed into the address bar of the open page: the team shown stays, and so does the tidy link
  handlers.click({ target: { id: "", closest: (sel) => (sel === "[data-t]" ? { dataset: { t: String(data.teams.findIndex((t) => t.abbr === "TTU")) } } : null) } });
  await settle();
  assert.equal(sandbox.location.hash, "#ttu");
  sandbox.location.hash = "#zzz";
  handlers["window:hashchange"]();
  await settle();
  assert.equal(sandbox.location.hash, "#ttu");
  assert.match(text(els.team.innerHTML), /Texas Tech/);
});

test("a pick reads the selected team's new odds out to screen readers", async () => {
  const html = fs.readFileSync(path.join(root, "app.html"), "utf8");
  assert.match(html, /<p class="vh" id="announce" aria-live="polite"><\/p>/, "a polite live region outside the re-rendered parts");
  const { els, handlers, sandbox } = render(data, "#ttu");
  await settle();
  sandbox.document.getElementById("announce");
  assert.equal(els.announce.textContent, "", "nothing read out on load");
  const pick = (k, v) => handlers.click({ target: { id: "", closest: (sel) => (sel === ".seg button" ? { dataset: { k: String(k), v } } : null) } });
  pick(0, "1");
  await settle();
  const hero = /id="heroPct">([^<]+)</.exec(els.team.innerHTML)[1].replace("&lt;", "<");
  assert.equal(els.announce.textContent, `Texas Tech: ${hero} to reach the title game, with 1 result set by you.`);
  handlers.click({ target: { id: "clearLocks", closest: () => null } });
  await settle();
  assert.match(els.announce.textContent, /^Texas Tech: .+ to reach the title game, with no results set\.$/);
  // re-sorting changes no odds, so it says nothing new
  const said = els.announce.textContent;
  els.announce.textContent = "";
  handlers.click({ target: { id: "", closest: (sel) => (sel === ".rg-sort button" ? { dataset: { sort: "swing" } } : null) } });
  await settle();
  assert.equal(els.announce.textContent, "");
  assert.ok(said);
});

test("the odds preview on a result's button works from the keyboard as well as on hover", async () => {
  const { els, handlers, sandbox } = render(data, "#utah");
  await settle();
  for (const id of ["heroPct", "heroLbl"]) sandbox.document.getElementById(id);
  assert.match(els.team.innerHTML, /<button [^>]*data-odds="[^"]+"/, "rooting guide buttons carry their odds");
  const btn = (odds, who) => { const b = { dataset: { odds, if: who } }; b.closest = (sel) => (sel === ".seg button[data-odds]" ? b : null); return b; };
  const a = btn("80%", "Utah"), b = btn("41%", "BYU"), other = { closest: () => null };
  els.heroPct.innerHTML = "61%";
  els.heroLbl.textContent = "to reach the title game";
  handlers.focusin({ target: a });
  assert.equal(els.heroPct.textContent, "80%");
  assert.equal(els.heroLbl.textContent, "if Utah wins");
  handlers.focusout({ target: a, relatedTarget: b }); // tabbing on to the other result
  handlers.focusin({ target: b });
  assert.equal(els.heroPct.textContent, "41%");
  assert.equal(els.heroLbl.textContent, "if BYU wins");
  els.heroPct.innerHTML = "";
  handlers.focusout({ target: b, relatedTarget: other });
  assert.equal(els.heroPct.innerHTML, "61%", "leaving the buttons puts the real odds back");
  assert.equal(els.heroLbl.textContent, "to reach the title game");
  handlers.focusin({ target: a });
  handlers.focusout({ target: a, relatedTarget: null }); // focus leaves the page
  assert.equal(els.heroPct.innerHTML, "61%");
  // hover still works the same way
  handlers.mouseover({ target: b });
  assert.equal(els.heroPct.textContent, "41%");
  handlers.mouseover({ target: other });
  assert.equal(els.heroLbl.textContent, "to reach the title game");
});

test("light-mode text meets WCAG AA (4.5:1) on the upset odds and the odds pill; dark mode unchanged", () => {
  const css = fs.readFileSync(path.join(root, "app.html"), "utf8").split("</style>")[0];
  const block = (re) => Object.fromEntries([...re.exec(css)[1].matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = block(/:root \{([\s\S]*?)\n\}/);
  const dark = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, k) => s + v * [0.2126, 0.7152, 0.0722][k], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [fg, bg] of [["--warn", "--sunk"], ["--warn", "--warn-soft"], ["--bar-ink", "--bar"], ["--bar-ink", "--sunk"], ["--accent", "--bar"]]) {
    assert.ok(ratio(light[fg], light[bg]) >= 4.5, `light ${fg} on ${bg}: ${ratio(light[fg], light[bg]).toFixed(2)}:1`);
  }
  assert.match(css, /\.pick \.odds b \{[^}]*color: var\(--bar-ink\)/, "the pill's text uses its own token");
  // dark mode keeps its colors: the pill text is the same gray as before
  assert.equal(dark["--bar-ink"], dark["--muted"]);
  assert.equal(dark["--warn"], "#e2b553");
  const media = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/);
  assert.deepEqual(media, dark, "system dark mode and the explicit dark theme agree");
});

// ---- Gameday page ----
// The same template built as a league's gameday page (fetch_data.py sets GAMEDAY).
const gamedayScripts = pageScripts.map((src) => src.replace("/*__GAMEDAY__*/false", "true"));
function renderGameday(d, extra) {
  const saved = pageScripts.slice();
  pageScripts.splice(0, pageScripts.length, ...gamedayScripts);
  try { return render(d, "", extra); } finally { pageScripts.splice(0, pageScripts.length, ...saved); }
}
// The page's clock, fixed: new Date() and Date.now() read `iso`; dates given explicitly are untouched.
const clockAt = (iso) => {
  const t = Date.parse(iso);
  return class extends Date { constructor(...a) { if (a.length) super(...a); else super(t); } static now() { return t; } };
};
const FRIDAY_WK12 = "2026-11-20T18:00Z"; // the fixture's week 12, before its first kickoff
function gameday(d = data) {
  const wk = JSON.parse(JSON.stringify(d));
  const byId = Object.fromEntries(wk.teams.map((t, i) => [t.id, i]));
  const utah = wk.teams.find((t) => t.abbr === "UTAH").id, tcu = wk.teams.find((t) => t.abbr === "TCU").id;
  // the week began with Utah 20 points lower and TCU 3 higher than now
  const now = d.exact && d.exact.teams ? d.exact.teams.map((t) => t.p) : null;
  wk.baseline = { week: 12, at: "2026-11-16T09:00Z", odds: Object.fromEntries(wk.teams.map((t, i) => [t.id, now ? now[i] : 0.1])) };
  if (now) { wk.baseline.odds[utah] = now[byId[utah]] - 0.2; wk.baseline.odds[tcu] = now[byId[tcu]] + 0.03; }
  wk.leagues = [{ id: "big12", name: "Big 12", path: "", group: 4 }, { id: "sec", name: "SEC", path: "sec/", group: 8 }];
  const w12 = wk.games.filter((g) => g.week === 12);
  Object.assign(w12[0], { tv: "FS1", spread: "UCF -6.5", overUnder: 52.5, venue: "Acrisure Bounce House", timeValid: true });
  Object.assign(w12[1], { tv: "FOX", spread: "TCU -3", timeValid: false });
  return wk;
}

test("gameday: the slate with kickoff, TV, line and what each game does to the race", async () => {
  const { els } = renderGameday(gameday(), { Date: clockAt(FRIDAY_WK12) });
  await settle();
  assert.equal(els.gameday.hidden, false);
  for (const id of ["picker", "team", "method", "rules"]) assert.equal(els[id].hidden, true, id + " hidden");
  assert.equal(els.title.textContent, "Big 12 Gameday");
  assert.match(text(els.lede.innerHTML), /^Week 12: 8 games\. What each result does to the title race, and how it has moved this week\.$/);
  assert.match(els.gameday.innerHTML, /Live odds of reaching the title game, updated every 15 minutes on game days\./);
  const gd = text(els.gameday.innerHTML);
  assert.match(gd, /FS1/);
  assert.match(gd, /UCF -6\.5 · O\/U 52\.5 · Acrisure Bounce House/);
  assert.match(gd, /Sat · time TBD · FOX/, "an unset kickoff shows its day in Eastern time, not 5 hours early");
  assert.equal((els.gameday.innerHTML.match(/Biggest stakes/g) || []).length, 1);
  assert.match(gd, /Title-game odds If UTAH If TCU/);
  // r/CFB: not offered yet, more than two hours before kickoff (Friday 23:00Z; it's 18:00Z)
  assert.doesNotMatch(els.gameday.innerHTML, /reddit\.com/);
  assert.match(text(els.gameday.innerHTML), /ESPN X/);
  const order = [...els.gameday.innerHTML.matchAll(/gameId\/(\d+)/g)].map((m) => m[1]);
  assert.equal(order[0], gameday().games.filter((g) => g.week === 12)[0].id, "kickoff order");
  // the league switch goes to the other leagues' gameday pages
  assert.match(els.leagues.innerHTML, /href="\.\.\/sec\/gameday\/"/);
  assert.match(els.leagues.innerHTML, /href="\.\/" aria-current="page"/);
});

test("gameday: a finished game keeps what its result did to the race, biggest first, in a line under its chart", async () => {
  const wk = gameday();
  const id = (ab) => wk.teams.find((t) => t.abbr === ab).id;
  const [g, other] = wk.games.filter((x) => x.week === 12);
  Object.assign(g, { completed: true, winner: g.home, homeScore: 42, awayScore: 32,
    moved: { [id("HOU")]: [0.2147, 0.01764], [id("BYU")]: [0.1935, 0.3004], [id("ARIZ")]: [0.09481, 0.08811],
      [id("UTAH")]: [0.922, 0.9246], "999": [0.1, 0.5], [id("TCU")]: ["x", 1] } });
  other.moved = { [id("BYU")]: [0.1, 0.3] }; // not played yet: not shown
  const { els, handlers } = renderGameday(wk, { Date: clockAt(FRIDAY_WK12) });
  await settle();
  const card = (gid) => els.gameday.innerHTML.split("<article").find((c) => c.includes(`data-gid="${gid}"`));
  const line = card(g.id).match(/<div class="gc-moved">.*?<\/div><\/div><\/div>/);
  assert.ok(line, "the line is on the finished card");
  // HOU -20, BYU +11, ARIZ -1; Utah's 0.3 point rounds to nothing; unknown teams and bad values dropped
  assert.match(text(line[0]), /^ Title odds HOU &#9660;20 down 20 points BYU &#9650;11 up 11 points ARIZ &#9660;1 down 1 point $/);
  assert.doesNotMatch(card(other.id), /gc-moved/);
  // following BYU marks it in the line
  handlers.click({ target: { closest: (q) => (q === "[data-rt]" ? { dataset: { rt: String(wk.teams.findIndex((t) => t.abbr === "BYU")) } } : null) } });
  assert.match(card(g.id), /<span class="mv me"><b>BYU<\/b>/);
});

test("gameday: live scores every 30 seconds from the live worker while games are under way", async () => {
  const wk = gameday();
  const g = wk.games.filter((x) => x.week === 12)[0];
  Object.assign(g, { date: "2026-11-20T17:00Z", timeValid: true });
  const asked = [], timers = [];
  let reply = { [g.id]: { pts: [[0, 500], [900, 700]], final: false, detail: "0:00 - 1st", homeScore: 14, awayScore: 3 } };
  const saved = gamedayScripts.slice();
  gamedayScripts.splice(0, gamedayScripts.length, ...saved.map((src) => src.replace('/*__LIVE__*/""', '"https://live.example/"')));
  let r;
  try {
    r = renderGameday(wk, {
      Date: clockAt(FRIDAY_WK12),
      fetch: async (url) => {
        if (url.startsWith("https://live.example/")) { asked.push(url); return { ok: true, json: async () => JSON.parse(JSON.stringify(reply)) }; }
        return { ok: true, json: async () => JSON.parse(JSON.stringify(wk)) };
      },
      setTimeout: (fn, ms) => { if (ms === 30e3 || ms === 60e3) { timers.push({ fn, ms }); return timers.length; } const t = setTimeout(fn, ms); t.unref(); return t; },
    });
  } finally { gamedayScripts.splice(0, gamedayScripts.length, ...saved); }
  const { els } = r;
  await settle();
  // asked at once, for the one game under way, and its card shows the score and clock
  assert.deepStrictEqual(asked, [`https://live.example/live?ids=${g.id}`]);
  const card = () => els.gameday.innerHTML.split("<article").find((c) => c.includes(`data-gid="${g.id}"`));
  assert.match(card(), /0:00 - 1st/);
  assert.match(text(card()), /14/);
  // the next ask in 30 seconds; a malformed reply is ignored
  const next = () => { const i = timers.findIndex((x) => x.ms === 30e3); return timers.splice(i, 1)[0].fn; };
  reply = { [g.id]: { pts: "<b>", final: false, detail: "<script>", homeScore: 99, awayScore: 0 } };
  next()();
  await settle();
  assert.strictEqual(asked.length, 2);
  assert.doesNotMatch(card(), /99|script/);
  // ESPN calls it final: the card says so, and the game isn't asked about again
  reply = { [g.id]: { pts: [[0, 500], [900, 700], [3600, 1000]], final: true, detail: "Final", homeScore: 28, awayScore: 10 } };
  next()();
  await settle();
  assert.match(card(), /Final/);
  next()();
  await settle();
  assert.strictEqual(asked.length, 3, "nothing under way: no ask");
});

test("gameday: an open page checks for new data every minute and redraws with it, keeping the followed team", async () => {
  const wk = gameday();
  let served = wk, fetches = 0;
  const timers = [];
  const { els, handlers } = renderGameday(wk, {
    Date: clockAt(FRIDAY_WK12),
    fetch: async () => { fetches++; return { ok: true, json: async () => JSON.parse(JSON.stringify(served)) }; },
    setTimeout: (fn, ms) => { if (ms === 60e3) { timers.push(fn); return timers.length; } const t = setTimeout(fn, ms); t.unref(); return t; },
  });
  await settle();
  assert.equal(fetches, 1);
  assert.equal(timers.length, 1, "a check is scheduled a minute out");
  const utah = wk.teams.findIndex((t) => t.abbr === "UTAH");
  handlers.click({ target: { closest: (q) => (q === "[data-rt]" ? { dataset: { rt: String(utah) } } : null) } });
  const before = els.gameday.innerHTML;
  // nothing new published: the check changes nothing and schedules the next one
  timers.shift()();
  await settle();
  assert.equal(fetches, 2);
  assert.equal(els.gameday.innerHTML, before);
  assert.equal(timers.length, 1);
  // a new build: week 12's first game is under way with a score
  served = JSON.parse(JSON.stringify(wk));
  served.fetchedAt = "2026-11-20T18:15:00Z";
  const g = served.games.filter((x) => x.week === 12)[0];
  g.date = "2026-11-20T17:00Z";
  g.wp = { pts: [[0, 500], [900, 640]], homeScore: 14, awayScore: 3, clock: "0:00", period: 1 };
  timers.shift()();
  await settle();
  assert.equal(fetches, 3);
  assert.notEqual(els.gameday.innerHTML, before, "redrawn with the new data");
  assert.match(els.gameday.innerHTML, new RegExp(`data-rt="${utah}" aria-pressed="true"`), "still following Utah");
  assert.match(text(els.foot.innerHTML), /picks up each update on its own/);
  assert.equal(timers.length, 1, "and keeps checking");
  // the click handler now belongs to the new page; clicking Utah again stops following it
  handlers.click({ target: { closest: (q) => (q === "[data-rt]" ? { dataset: { rt: String(utah) } } : null) } });
  assert.match(els.gameday.innerHTML, new RegExp(`data-rt="${utah}" aria-pressed="false"`));
});

// The CFP committee's ranking (DATA.cfp): a small rank before a ranked team's name, on both pages.
function ranked(d) {
  const r = JSON.parse(JSON.stringify(d));
  const id = (ab) => r.teams.find((t) => t.abbr === ab).id;
  r.cfp = { date: "2026-11-10T08:00Z", week: 11, ranks: { [id("UTAH")]: 2, [id("TCU")]: 23, [id("BYU")]: "<b>9</b>" } };
  return r;
}

test("CFP rankings: the rank before a ranked team's name in the picker, header, path and standings; the source in the footer", async () => {
  const { els } = render(ranked(data), "#utah");
  await settle();
  const rk = (n) => new RegExp(`<span class="rk" title="CFP ranking, Nov 10"><span class="vh">CFP No\\. </span>${n}</span>`);
  assert.match(els.picker.innerHTML, new RegExp(rk(2).source + "UTAH"));
  assert.match(els.picker.innerHTML, new RegExp(rk(23).source + "TCU"));
  assert.match(els.team.innerHTML, new RegExp("<h2>" + rk(2).source + "Utah Utes</h2>"));
  const say = text(els.team.innerHTML);
  assert.match(say, /^\s*CFP No\. 2 Utah Utes 7-0 Big 12/);
  assert.match(say, /CFP No\. 2 Utah W at CFP No\. 23 TCU 74%/, "path games");
  assert.match(say, /#1 CFP No\. 2 Utah Utes 9-0 #2 Houston Cougars/, "standings");
  assert.match(say, /CFP No\. 2 UTAH at CFP No\. 23 TCU ESPN: UTAH 74%/, "rooting guide");
  // a rank that isn't a whole number is dropped, not rendered
  assert.doesNotMatch(els.picker.innerHTML + els.team.innerHTML, /<b>9<\/b>|CFP No\. <b>/);
  assert.match(els.foot.innerHTML, /the CFP committee's rankings of Nov 10/);
  // nobody else gets a number
  assert.equal((els.picker.innerHTML.match(/class="rk"/g) || []).length, 2);
});

test("CFP rankings: none in the data, no badges and no mention", async () => {
  const { els } = render(data, "#utah");
  await settle();
  assert.doesNotMatch(els.picker.innerHTML + els.team.innerHTML + els.foot.innerHTML, /class="rk"|CFP committee/);
});

test("gameday: ranked teams carry their CFP rank in the race and on the game cards", async () => {
  const { els } = renderGameday(ranked(gameday()), { Date: clockAt(FRIDAY_WK12) });
  await settle();
  const html = els.gameday.innerHTML;
  assert.match(html, /<b><span class="rk"[^>]*><span class="vh">CFP No\. <\/span>2<\/span>UTAH<\/b>/);
  assert.match(html, /<span><span class="rk"[^>]*><span class="vh">CFP No\. <\/span>23<\/span>TCU<\/span>/);
});

test("gameday: the race lists every team by its odds now, with the week's start and the change", async () => {
  const wk = gameday();
  const { els } = renderGameday(wk, { Date: clockAt(FRIDAY_WK12) });
  await settle();
  const race = els.gameday.innerHTML.split('<div class="race">')[1].split("</section>")[0];
  assert.doesNotMatch(race, /<a /, "rows stay on this page");
  const rows = [...race.matchAll(/<button type="button" data-rt="(\d+)".*?<\/button>/g)];
  assert.equal(rows.length, data.teams.length);
  const p = rows.map((r) => wk.exact.teams[+r[1]].p);
  assert.deepEqual(p, [...p].sort((x, y) => y - x), "highest odds first");
  const row = (abbr) => rows.find((r) => r[0].includes(`<b>${abbr}</b>`))[0];
  assert.match(row("UTAH"), /&#9650;20<\/span><span class="vh">up 20 points this week/);
  assert.match(row("TCU"), /&#9660;3/);
  assert.match(row("BYU"), /class="delta"><span aria-hidden="true">&ndash;/);
});

test("gameday: picking a team in the race highlights its games and its row in every game; again clears it", async () => {
  const wk = gameday();
  const { els, handlers } = renderGameday(wk, { Date: clockAt(FRIDAY_WK12) });
  await settle();
  const utah = wk.teams.findIndex((t) => t.abbr === "UTAH");
  const click = () => handlers.click({ target: { closest: (q) => (q === "[data-rt]" ? { dataset: { rt: String(utah) } } : null) } });
  click();
  const html = els.gameday.innerHTML;
  assert.match(html, new RegExp(`data-rt="${utah}" aria-pressed="true"`));
  const cards = html.split("<article").slice(1);
  const mine = cards.filter((c) => /^ data-gid="\d+" class="gc[^"]* mine/.test(c));
  assert.equal(mine.length, 1, "Utah's one game this week");
  assert.match(mine[0], /Utah/);
  const rowsMe = (html.match(/<span class="t me" role="cell">[^]*?UTAH<\/span>/g) || []).length;
  const listed = cards.filter((c) => /role="cell">(?:<img[^>]*>)*UTAH<\/span>/.test(c)).length;
  assert.ok(rowsMe > 0 && rowsMe === listed, "every listed Utah row is highlighted");
  assert.equal((html.match(/class="v[^"]* me"/g) || []).length, rowsMe * 2, "both odds cells too");
  click();
  assert.doesNotMatch(els.gameday.innerHTML, / mine"| me"|aria-pressed="true"/);
});

test("gameday: a picked team's row shows in a game even when it's not among the five it moves most", async () => {
  const wk = gameday();
  // the first game of the week moves every team, the last team least (2 points)
  const g = wk.games.filter((x) => x.week === 12)[0], k = wk.exact.gameIds.indexOf(g.id), n = wk.teams.length;
  wk.exact.teams.forEach((t, i) => { t.games[k] = { ...t.games[k], pA: 0.4, pH: 0.4 + 0.01 * (n - i + 1) }; });
  const { els, handlers } = renderGameday(wk, { Date: clockAt(FRIDAY_WK12) });
  await settle();
  const card = () => els.gameday.innerHTML.split("<article").slice(1).find((c) => c.includes("gameId/" + g.id));
  const listed = () => [...card().matchAll(/class="t( me)?" role="cell">(?:<img[^>]*>)*([^<]+)</g)].map((m) => m[2] + (m[1] ? "*" : ""));
  assert.equal(listed().length, 5);
  handlers.click({ target: { closest: (q) => (q === "[data-rt]" ? { dataset: { rt: String(n - 1) } } : null) } });
  assert.deepEqual(listed(), [...wk.teams.slice(0, 5).map((t) => t.abbr), wk.teams[n - 1].abbr + "*"]);
});

test("gameday: no changes without the week's own starting odds; nothing outside the season", async () => {
  const wk = gameday();
  wk.baseline.week = 11;
  let r = renderGameday(wk, { Date: clockAt(FRIDAY_WK12) });
  await settle();
  assert.match(r.els.gameday.innerHTML, /Biggest stakes/, "the games still show");
  assert.doesNotMatch(r.els.gameday.innerHTML, /&#9650;|&#9660;|&rarr; /);
  r = renderGameday(gameday(), { Date: clockAt("2027-01-10T18:00Z") });
  await settle();
  assert.equal(r.els.gameday.innerHTML, "");
  assert.match(r.els.lede.innerHTML, /No Big 12 games to show this week/);
});

test("gameday: a simulated league shows stakes, precomputed or simulated on the page", async () => {
  const { presim, inputsKey } = require("../exact.js");
  const noExact = { ...data, exact: { skipped: "too many" } };
  const withSim = { ...noExact, sim: JSON.parse(JSON.stringify(presim(noExact, inputsKey(noExact)))) };
  for (const d of [withSim, noExact]) {
    const { els } = renderGameday(gameday(d), { Date: clockAt(FRIDAY_WK12) });
    await settle();
    assert.match(text(els.gameday.innerHTML), /Title-game odds If UTAH If TCU/);
    assert.equal((els.gameday.innerHTML.match(/Biggest stakes/g) || []).length, 1);
  }
});

test("gameday: ESPN's TV, line and venue text is escaped", async () => {
  const wk = gameday();
  const g = wk.games.find((x) => x.week === 12);
  Object.assign(g, { tv: '<img src=x onerror="alert(1)">', spread: "<b>X</b>", venue: "A&B" });
  const { els } = renderGameday(wk, { Date: clockAt(FRIDAY_WK12) });
  await settle();
  assert.doesNotMatch(els.gameday.innerHTML, /<img src=x|<b>X/);
  assert.match(els.gameday.innerHTML, /&lt;b&gt;X&lt;\/b&gt; · O\/U 52\.5 · A&amp;B/);
});

test("top bar: a Paths | Gameday switch while the week has games, the current view marked", async () => {
  let r = render(gameday(), "#utah", { Date: clockAt(FRIDAY_WK12) });
  await settle();
  assert.ok(!r.els.gameday || r.els.gameday.innerHTML === "", "the league page doesn't render the gameday view");
  assert.equal(r.els.modes.hidden, false);
  assert.equal(r.els.modes.innerHTML, '<a href="./" aria-current="page">Paths</a><a href="gameday/">Gameday</a>');
  assert.doesNotMatch(r.els.picker.innerHTML, /delta|&#9650;/);
  r = renderGameday(gameday(), { Date: clockAt(FRIDAY_WK12) });
  await settle();
  assert.equal(r.els.modes.innerHTML, '<a href="../">Paths</a><a href="./" aria-current="page">Gameday</a>');
  // outside the season: no switch on the league page; the gameday page keeps it, to get back
  r = render(gameday(), "#utah", { Date: clockAt("2027-01-10T18:00Z") });
  await settle();
  assert.equal(r.els.modes.hidden, true);
  r = renderGameday(gameday(), { Date: clockAt("2027-01-10T18:00Z") });
  await settle();
  assert.equal(r.els.modes.hidden, false);
});

test("top bar: Gameday carries a live marker while a game is under way, and not after", async () => {
  const wk = gameday();
  const g = wk.games.filter((x) => x.week === 12)[0]; // Friday 23:00Z
  const at = async (iso, extra = {}) => { Object.assign(g, extra); const r = render(wk, "#utah", { Date: clockAt(iso) }); await settle(); return r.els.modes.innerHTML; };
  assert.doesNotMatch(await at(FRIDAY_WK12), /dot/, "before kickoff");
  assert.match(await at("2026-11-21T00:30Z"), /<span class="dot" aria-hidden="true"><\/span>Gameday<span class="vh">, games under way<\/span>/);
  assert.doesNotMatch(await at("2026-11-21T00:30Z", { wp: { pts: [], final: true } }), /dot/, "ESPN called it final");
  assert.doesNotMatch(await at("2026-11-21T04:30Z", { wp: null }), /dot/, "more than 5 hours on (and before the next kickoff), never live");
});

test("gameday: a game under way shows ESPN's clock, the score and its win-probability chart; a final one, the result", async () => {
  const wk = gameday();
  const [g0, g1] = wk.games.filter((g) => g.week === 12);
  g0.wp = { pts: [[0, 600], [1200, 350], [2000, 820]], final: false, detail: "3rd 4:12", homeScore: 21, awayScore: 14 };
  g1.wp = { pts: [[0, 300], [3600, 0], [3840, 0]], final: true, detail: "Final/OT", homeScore: 20, awayScore: 27 };
  g1.timeValid = true;
  const { els } = renderGameday(wk, { Date: clockAt("2026-11-21T08:00Z") });
  await settle();
  const cards = els.gameday.innerHTML.split("<article").slice(1);
  const live = cards.find((c) => c.includes("gameId/" + g0.id)), fin = cards.find((c) => c.includes("gameId/" + g1.id));
  assert.match(live, /<span class="live">3rd 4:12<\/span>/);
  assert.match(text(live), /Iowa State 14 UCF 21/);
  assert.match(live, /role="img" aria-label="ESPN win probability: ISU 18%, UCF 82%"/);
  assert.match(live, /<polyline points="0\.0,48\.0 100\.0,28\.0 166\.7,65\.6"/, "home odds downward, a 60-minute axis");
  assert.match(live, /Title-game odds/, "stakes stay up while it's being played");
  assert.match(fin, /Final/);
  assert.match(fin, /class="gc-team won">.*Utah.*27/);
  assert.match(fin, />OT</, "overtime gets its own stretch of the axis");
  assert.doesNotMatch(fin, /Title-game odds/);
});

test("gameday: a picked team's game comes first, then the games that move it, biggest first; the rest dimmed", async () => {
  const wk = gameday();
  const { els, handlers } = renderGameday(wk, { Date: clockAt(FRIDAY_WK12) });
  await settle();
  const order = () => [...els.gameday.innerHTML.matchAll(/<article data-gid="(\d+)" class="gc([^"]*)"/g)].map((m) => ({ id: m[1], dim: / dim/.test(m[2]) }));
  const kickoffOrder = order().map((c) => c.id);
  assert.ok(order().every((c) => !c.dim), "nothing dimmed until a team is picked");
  const byu = wk.teams.findIndex((t) => t.abbr === "BYU");
  handlers.click({ target: { closest: (q) => (q === "[data-rt]" ? { dataset: { rt: String(byu) } } : null) } });
  const cards = order(), games = wk.games.filter((g) => g.week === 12);
  const own = games.find((g) => g.home === wk.teams[byu].id || g.away === wk.teams[byu].id);
  assert.equal(cards[0].id, own.id, "BYU's own game first");
  // the cards after it: the ones listing a BYU row, by BYU's swing, then the dimmed rest in kickoff order
  const html = els.gameday.innerHTML.split("<article").slice(1);
  const swing = (id) => {
    const c = html.find((x) => x.includes(`data-gid="${id}"`));
    const m = c.match(/BYU<\/span><span class="v[^"]*" role="cell">([\d.]+)%<\/span><span class="v[^"]*" role="cell">([\d.]+)%/);
    return m ? Math.abs(+m[1] - +m[2]) : null;
  };
  const moving = cards.slice(1).filter((c) => !c.dim), rest = cards.filter((c) => c.dim);
  assert.ok(moving.length > 0 && rest.length > 0);
  assert.ok(moving.every((c) => swing(c.id) != null), "every undimmed game lists BYU");
  assert.ok(rest.every((c) => swing(c.id) == null), "no dimmed game lists BYU");
  const sw = moving.map((c) => swing(c.id));
  assert.deepEqual(sw, [...sw].sort((x, y) => y - x), "biggest swing first (to the shown rounding)");
  assert.deepEqual(rest.map((c) => c.id), kickoffOrder.filter((id) => rest.some((c) => c.id === id)), "the rest keep kickoff order");
  assert.match(els.gameday.innerHTML, new RegExp(`<p class="gd-focus" role="status">BYU: its game first, then the ${moving.length} games? that move its odds most, biggest first\\.</p>`));
  // again: back to kickoff order, nothing dimmed, no note
  handlers.click({ target: { closest: (q) => (q === "[data-rt]" ? { dataset: { rt: String(byu) } } : null) } });
  assert.deepEqual(order().map((c) => c.id), kickoffOrder);
  assert.doesNotMatch(els.gameday.innerHTML, / dim"|gd-focus/);
});

test("gameday: a team with no game this week gets the games that move it first, and says so", async () => {
  const wk = gameday();
  const utah = wk.teams.find((t) => t.abbr === "UTAH").id;
  wk.games = wk.games.filter((g) => !(g.week === 12 && (g.home === utah || g.away === utah)));
  const { els, handlers } = renderGameday(wk, { Date: clockAt(FRIDAY_WK12) });
  await settle();
  const i = wk.teams.findIndex((t) => t.id === utah);
  handlers.click({ target: { closest: (q) => (q === "[data-rt]" ? { dataset: { rt: String(i) } } : null) } });
  assert.match(els.gameday.innerHTML, /<p class="gd-focus" role="status">Utah doesn't play this week(\. The \d+ games? that move its odds come first, biggest first|, and no game moves its odds by a point)\.<\/p>/);
});

test("gameday: the r/CFB link: that account's game threads, every word required, from two hours before kickoff", async () => {
  const wk = gameday();
  const g = wk.games.find((x) => x.week === 12), t = wk.teams.find((x) => x.id === g.home);
  const at = async (iso) => { const r = renderGameday(wk, { Date: clockAt(iso) }); await settle(); return r.els.gameday.innerHTML.split("<article").find((c) => c.includes(`data-gid="${g.id}"`)); };
  assert.doesNotMatch(await at("2026-11-20T20:59Z"), /reddit/, "more than two hours out");
  const card = await at("2026-11-20T21:00Z");
  // Iowa State at UCF: "Iowa State" searches as Iowa, matching r/CFB's full name
  assert.match(card, /href="https:\/\/www\.reddit\.com\/r\/CFB\/search\/\?q=author%3ACFB_Referee%20AND%20title%3A%22Game%20Thread%22%20AND%20title%3AIowa%20AND%20title%3AUCF&amp;restrict_sr=1&amp;sort=new" target="_blank" rel="noopener" title="The r\/CFB game thread">r\/CFB<\/a>/);
  assert.match(text(card), /ESPN r\/CFB X/);
  // accented names stay whole
  t.short = "San José St";
  assert.match(await at("2026-11-20T21:00Z"), /title%3ASan%20AND%20title%3AJos%C3%A9&amp;/);
  // an unset kickoff time: not offered
  g.timeValid = false;
  assert.doesNotMatch(await at("2026-11-21T04:00Z"), /reddit/);
});
