// The Cloudflare Worker in trigger/ that starts update.yml: what it sends GitHub, and that a
// refused dispatch fails loudly instead of silently stopping updates.
const test = require("node:test");
const assert = require("node:assert");

const env = { GITHUB_TOKEN: "t0ken", REPO: "jacoblords/big12champs", WORKFLOW: "update.yml", REF: "main", SITE: "https://site.example/" };
const load = () => import("../trigger/worker.mjs").then((m) => m.default);

test("the Worker's main module exports only what Cloudflare can run: handlers and the Durable Object", async () => {
  const m = await import("../trigger/worker.mjs");
  assert.deepStrictEqual(Object.keys(m).sort(), ["LiveCache", "default"]);
});

test("dispatches update.yml on main with force=false", async () => {
  const { dispatch } = await load();
  const calls = [];
  await dispatch(env, async (url, init) => (calls.push({ url, init }), new Response(null, { status: 204 })));
  assert.strictEqual(calls.length, 1);
  const { url, init } = calls[0];
  assert.strictEqual(url, "https://api.github.com/repos/jacoblords/big12champs/actions/workflows/update.yml/dispatches");
  assert.strictEqual(init.method, "POST");
  assert.strictEqual(init.headers.Authorization, "Bearer t0ken");
  assert.ok(init.headers["User-Agent"]);
  assert.deepStrictEqual(JSON.parse(init.body), { ref: "main", inputs: { force: "false" } });
});

test("a refused dispatch throws with GitHub's status", async () => {
  const { dispatch } = await load();
  const reply = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
  await assert.rejects(dispatch(env, reply), /401.*Bad credentials/);
});

test("a missing token throws before calling GitHub", async () => {
  const { dispatch } = await load();
  let called = false;
  await assert.rejects(dispatch({ ...env, GITHUB_TOKEN: "" }, async () => ((called = true), new Response())), /GITHUB_TOKEN/);
  assert.strictEqual(called, false);
});

test("the workflow accepts the force input the worker sends", () => {
  const yml = require("fs").readFileSync(require("path").join(__dirname, "../.github/workflows/update.yml"), "utf8");
  assert.match(yml, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*force:/);
  assert.match(yml, /github\.event\.inputs\.force != 'false'/);
});

// ---- /live: the gameday pages' live scores, one shared copy per game ----
const lib = () => Promise.all([import("../trigger/worker.mjs"), import("../trigger/live.mjs")]).then(([w, l]) => ({ ...l, LiveCache: w.LiveCache, default: w.default }));
const espnSummary = ({ final = false, kick = "2026-11-14T03:15Z", home = "35", away = "26", n = 3 } = {}) => ({
  drives: { previous: [{ plays: Array.from({ length: n }, (_, k) => ({ id: "p" + k, period: { number: 1 + Math.floor((4 * k) / n) }, clock: { displayValue: "7:30" } })) }] },
  winprobability: Array.from({ length: n }, (_, k) => ({ playId: "p" + k, homeWinPercentage: 0.5 + k / (2 * n) })),
  header: { competitions: [{ date: kick, status: { type: { completed: final, state: final ? "post" : "in", shortDetail: final ? "Final" : "10:00 - 4th" } },
    competitors: [{ homeAway: "home", score: home }, { homeAway: "away", score: away }] }] },
});
const LIVE_IDS = "https://site.example/live-ids.json";
const EXTRA_IDS = "https://other.example/fan-guide/live-ids.json";
function liveCache({ replies, now, allowed = () => ({ big12: ["401856860", "1", "2"] }), extra = null }) {
  const calls = [], store = new Map();
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.startsWith("https://api.github.com")) return new Response(null, { status: 204 });
    if (url === LIVE_IDS) { const r = allowed(); return r instanceof Response ? r : Response.json(r); }
    if (url === EXTRA_IDS && extra) { const r = extra(); return r instanceof Response ? r : Response.json(r); }
    const r = replies(url);
    return r instanceof Response ? r : Response.json(r);
  };
  const state = { storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } } };
  const e = extra ? { ...env, EXTRA_LIVE_IDS: `${EXTRA_IDS}, not-a-url` } : env;
  return lib().then(({ LiveCache }) => ({ cache: new LiveCache(state, e, fetchFn, now), calls }));
}
const ask = (cache, ids) => cache.fetch(new Request("https://live/?ids=" + ids)).then((r) => r.json());

test("slim: ESPN's summary cut to a game card's chart, score and clock, as fetch_data.py stores it", async () => {
  const { slim, WP_POINTS } = await lib();
  assert.deepStrictEqual(slim(espnSummary()), {
    pts: [[450, 500], [1350, 667], [2250, 833]], final: false, detail: "10:00 - 4th", homeScore: 35, awayScore: 26, state: "in",
  });
  assert.strictEqual(slim(espnSummary({ n: 500 })).pts.length, WP_POINTS);
  assert.deepStrictEqual(slim({}), { pts: [], final: false, detail: null, homeScore: null, awayScore: null, state: null });
});

test("slim: plays ESPN files out of place are dropped, the same ones fetch_data.py drops", async () => {
  const { slim, inOrder } = await lib();
  const games = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "fixtures/wp-out-of-order.json"), "utf8"));
  for (const [gid, g] of Object.entries(games)) assert.deepStrictEqual(slim(g.summary).pts, g.pts, gid);
  assert.deepStrictEqual(inOrder([]), []);
  assert.deepStrictEqual(inOrder([[0, 1], [900, 2], [3720, 3], [950, 4], [950, 5], [1000, 6]]), [[0, 1], [900, 2], [950, 4], [950, 5], [1000, 6]]);
});

test("live ids: only ESPN game ids, at most 24", async () => {
  const { parseIds } = await lib();
  assert.deepStrictEqual(parseIds("1,2,2"), ["1", "2"]);
  for (const bad of ["", "1,x", "../x", "1;2", Array.from({ length: 25 }, (_, k) => k + 1).join(",")]) assert.strictEqual(parseIds(bad), null, bad);
});

test("live: ESPN is asked once per game per 30 seconds however many ask, and never again once final", async () => {
  let t = Date.parse("2026-11-14T06:00Z"), final = false;
  const { cache, calls } = await liveCache({ replies: () => espnSummary({ final }), now: () => t });
  const espn = () => calls.filter((u) => u.includes("espn.com"));
  const [a, b] = await Promise.all([ask(cache, "401856860"), ask(cache, "401856860")]);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a["401856860"].homeScore, 35);
  assert.deepStrictEqual(espn(), ["https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=401856860"]);
  t += 29e3; await ask(cache, "401856860");
  assert.strictEqual(espn().length, 1, "still fresh at 29s");
  t += 2e3; final = true; await ask(cache, "401856860");
  assert.strictEqual(espn().length, 2, "asked again after 30s");
  t += 3600e3; const end = await ask(cache, "401856860");
  assert.strictEqual(espn().length, 2, "a final game is never asked about again");
  assert.strictEqual(end["401856860"].final, true);
});

test("live: a game going final starts the update workflow once, so its result lands in a minute or two", async () => {
  let t = Date.parse("2026-11-14T06:50Z");
  const { cache, calls } = await liveCache({ replies: () => espnSummary({ final: true }), now: () => t });
  await ask(cache, "401856860");
  const gh = () => calls.filter((u) => u.startsWith("https://api.github.com"));
  assert.deepStrictEqual(gh(), ["https://api.github.com/repos/jacoblords/big12champs/actions/workflows/update.yml/dispatches"]);
  // a fresh instance (Cloudflare restarted it) remembers it already did, from its storage
  cache.games.clear(); t += 60e3; await ask(cache, "401856860");
  assert.strictEqual(gh().length, 1);
});

test("live: an old game's final doesn't start the workflow", async () => {
  const { cache, calls } = await liveCache({ replies: () => espnSummary({ final: true, kick: "2026-11-07T03:15Z" }), now: () => Date.parse("2026-11-14T06:50Z") });
  await ask(cache, "401856860");
  assert.strictEqual(calls.filter((u) => u.startsWith("https://api.github.com")).length, 0);
});

test("live: ESPN failing gives null for that game, and isn't retried for 30 seconds", async () => {
  let t = 0;
  const { cache, calls } = await liveCache({ replies: () => new Response("busy", { status: 503 }), now: () => t });
  assert.deepStrictEqual(await ask(cache, "1,2"), { 1: null, 2: null });
  t += 10e3; await ask(cache, "1,2");
  assert.strictEqual(calls.filter((u) => u.includes("espn.com")).length, 2);
});

test("live: only the games in the site's live-ids.json are asked about, cached or can start the workflow", async () => {
  let t = Date.parse("2026-11-14T06:50Z");
  const { cache, calls } = await liveCache({ replies: () => espnSummary({ final: true }), now: () => t });
  assert.deepStrictEqual(await ask(cache, "401856860,999"), { 401856860: await ask(cache, "401856860").then((r) => r["401856860"]), 999: null });
  assert.ok(!calls.some((u) => u.includes("event=999")), "no ESPN call for a game the site doesn't list");
  assert.ok(!cache.games.has("999"), "nothing kept for it");
  assert.strictEqual(calls.filter((u) => u.startsWith("https://api.github.com")).length, 1, "only the listed game's final dispatched");
  assert.strictEqual(calls.filter((u) => u === LIVE_IDS).length, 1, "the list is read once...");
  t += 5 * 60e3; await ask(cache, "1");
  assert.strictEqual(calls.filter((u) => u === LIVE_IDS).length, 2, "...and again after 5 minutes");
});

test("live: a list that can't be read keeps the last good one, and none at all allows nothing", async () => {
  let t = 0, up = true;
  const { cache, calls } = await liveCache({ replies: () => espnSummary(), now: () => t,
    allowed: () => (up ? { sec: ["1", 2, "x"] } : new Response("down", { status: 503 })) });
  assert.notStrictEqual((await ask(cache, "1"))["1"], null);
  up = false; t += 5 * 60e3 + 31e3;
  assert.notStrictEqual((await ask(cache, "1"))["1"], null, "last good list kept");
  assert.strictEqual(calls.filter((u) => u === LIVE_IDS).length, 2);
  await ask(cache, "1");
  assert.strictEqual(calls.filter((u) => u === LIVE_IDS).length, 3, "a failed read is retried on the next request");
  assert.deepStrictEqual(await ask(cache, "2"), { 2: null }, "non-string ids in the list are ignored");

  const cold = await liveCache({ replies: () => espnSummary(), now: () => 0, allowed: () => new Response("", { status: 404 }) });
  assert.deepStrictEqual(await ask(cold.cache, "1"), { 1: null });
  assert.ok(!cold.calls.some((u) => u.includes("espn.com")));
});

test("live: another page's list (EXTRA_LIVE_IDS) allows its games too, without starting this workflow", async () => {
  let t = Date.parse("2026-11-14T06:50Z"), up = true;
  const { cache, calls } = await liveCache({ replies: () => espnSummary({ final: true }), now: () => t,
    extra: () => (up ? { fbs: ["777", "401856860"] } : new Response("down", { status: 503 })) });
  const r = await ask(cache, "777,401856860,999");
  assert.notStrictEqual(r["777"], null, "a game only the other page lists is served");
  assert.notStrictEqual(r["401856860"], null);
  assert.strictEqual(r["999"], null, "a game nobody lists is not");
  assert.ok(calls.some((u) => u.includes("event=777")));
  assert.strictEqual(calls.filter((u) => u.startsWith("https://api.github.com")).length, 1, "only this site's own final dispatched");
  assert.ok(!calls.includes("not-a-url"), "malformed list addresses are ignored");
  up = false; t += 5 * 60e3 + 31e3;
  assert.notStrictEqual((await ask(cache, "777"))["777"], null, "the other list's last good copy is kept");
  const own = await liveCache({ replies: () => espnSummary(), now: () => 0, extra: () => new Response("", { status: 404 }) });
  assert.notStrictEqual((await ask(own.cache, "1"))["1"], null, "this site's list works when the other is down");
});

test("allowedIds: the ids of every league in live-ids.json", async () => {
  const { allowedIds } = await lib();
  assert.deepStrictEqual([...allowedIds({ big12: ["1", "2"], sec: ["2", "3"], acc: "4", x: [null, "../5"] })].sort(), ["1", "2", "3"]);
  for (const bad of [null, [], "1", 1]) assert.strictEqual(allowedIds(bad), null);
});

test("live endpoint: CORS for titlepaths.com and localhost only, bad requests refused", async () => {
  const { default: worker } = await lib();
  const liveEnv = { ...env, ORIGINS: "https://titlepaths.com,https://www.titlepaths.com", LIVE: {
    idFromName: (n) => n, get: () => ({ fetch: async (u) => Response.json({ seen: new URL(u).searchParams.get("ids") }) }) } };
  const get = (path, origin) => worker.fetch(new Request("https://w.example" + path, { headers: origin ? { Origin: origin } : {} }), liveEnv);
  let r = await get("/live?ids=1,2", "https://titlepaths.com");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("Access-Control-Allow-Origin"), "https://titlepaths.com");
  assert.deepStrictEqual(await r.json(), { seen: "1,2" });
  r = await get("/live?ids=1", "http://localhost:8000");
  assert.strictEqual(r.headers.get("Access-Control-Allow-Origin"), "http://localhost:8000");
  r = await get("/live?ids=1", "https://evil.example");
  assert.strictEqual(r.headers.get("Access-Control-Allow-Origin"), null);
  assert.strictEqual((await get("/live?ids=x")).status, 400);
  assert.strictEqual((await get("/")).status, 404);
});
