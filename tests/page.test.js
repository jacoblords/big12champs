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
    fetch: async () => ({ ok: true, json: async () => data }), console, Math, Date, JSON, setTimeout, Promise,
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
  assert.match(text(els.lede.innerHTML), /^Week 12: 8 games\. What each result does to the title race, and how it has moved this week\. Every team's path/);
  assert.match(els.gameday.innerHTML, /Live odds of reaching the title game, updated every 15 minutes on game days\./);
  const gd = text(els.gameday.innerHTML);
  assert.match(gd, /FS1/);
  assert.match(gd, /UCF -6\.5 · O\/U 52\.5 · Acrisure Bounce House/);
  assert.match(gd, /Sat · time TBD · FOX/, "an unset kickoff shows its day in Eastern time, not 5 hours early");
  assert.equal((els.gameday.innerHTML.match(/Biggest stakes/g) || []).length, 1);
  assert.match(gd, /Title-game odds If UTAH If TCU/);
  assert.match(els.gameday.innerHTML, /reddit\.com\/r\/CFB\/search\/\?q=%22Game%20Thread%22%20Utah%20TCU/);
  const order = [...els.gameday.innerHTML.matchAll(/gameId\/(\d+)/g)].map((m) => m[1]);
  assert.equal(order[0], gameday().games.filter((g) => g.week === 12)[0].id, "kickoff order");
  // the league switch goes to the other leagues' gameday pages
  assert.match(els.leagues.innerHTML, /href="\.\.\/sec\/gameday\/"/);
  assert.match(els.leagues.innerHTML, /href="\.\/" aria-current="page"/);
});

test("gameday: the race lists every team, biggest gain first, with the week's start and now", async () => {
  const { els } = renderGameday(gameday(), { Date: clockAt(FRIDAY_WK12) });
  await settle();
  const race = els.gameday.innerHTML.split('<div class="race">')[1].split("</section>")[0];
  assert.doesNotMatch(race, /<a /, "rows stay on this page");
  const rows = [...race.matchAll(/<div(?: class="out")?>.*?<b>([^<]+)<\/b>.*?<\/span><\/span><\/div>/g)];
  assert.equal(rows.length, data.teams.length);
  assert.equal(rows[0][1], "UTAH");
  assert.match(rows[0][0], /&#9650;20<\/span><span class="vh">up 20 points this week/);
  assert.equal(rows[rows.length - 1][1], "TCU", "the biggest drop last");
  assert.match(rows[rows.length - 1][0], /&#9660;3/);
  assert.match(rows[1][0], /class="delta"><span aria-hidden="true">&ndash;/);
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

test("league page: no gameday content, just a link to it during the week", async () => {
  let r = render(gameday(), "#utah", { Date: clockAt(FRIDAY_WK12) });
  await settle();
  assert.ok(!r.els.gameday || r.els.gameday.innerHTML === "", "the gameday view isn't rendered");
  assert.equal(r.els.gdlink.hidden, false);
  assert.equal(r.els.gdlink.textContent, "Week 12 gameday");
  assert.doesNotMatch(r.els.picker.innerHTML, /delta|&#9650;/);
  r = render(gameday(), "#utah", { Date: clockAt("2027-01-10T18:00Z") });
  await settle();
  assert.equal(r.els.gdlink.hidden, true);
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
