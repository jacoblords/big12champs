// Two jobs, one Cloudflare Worker:
//
// 1. Starts the "Update data and deploy" workflow on a clock GitHub doesn't throttle (cron).
//    GitHub runs scheduled workflows on a best-effort basis, and for this repo that came out as
//    once every 4-8 hours instead of every 15-30 minutes. A Cloudflare cron trigger fires on
//    time, and a workflow_dispatch it sends starts at once. The schedule lives in wrangler.toml.
//    The dispatch passes force=false, so the run deploys only when ESPN data changed, exactly
//    like a scheduled run. A click on "Run workflow" in GitHub still defaults to a forced rebuild.
//
// 2. Live scores for the gameday pages (GET /live?ids=…): the score, clock and win-probability
//    chart of games under way, between the workflow's 15-minute runs. Every visitor's request
//    goes through one Durable Object, which asks ESPN about a game at most once every LIVE_TTL_MS
//    however many people are watching, and never again once ESPN calls it final. When it sees a
//    game go final it starts the workflow once, so the result and the odds land in a minute or
//    two instead of at the next 15-minute run.

import { LIVE_TTL_MS, parseIds, slim } from "./live.mjs";

const API = "https://api.github.com";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const UA = "titlepaths-live (cloudflare worker; one shared copy per game)";
const RECENT_MS = 8 * 3600e3; // a final only starts the workflow for a game that kicked off lately
const FORGET_MS = 12 * 3600e3;

async function dispatch(env, fetchFn = fetch) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set (wrangler secret put GITHUB_TOKEN)");
  const url = `${API}/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "titlepaths-trigger (cloudflare cron)",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.REF, inputs: { force: "false" } }),
  });
  // 204 normally; 200 if GitHub ever answers with run details. A failure throws so the
  // Cloudflare dashboard marks the invocation failed and logs why (401 = expired token).
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`GitHub answered ${res.status} to the dispatch: ${detail}`);
  }
}

// One instance (named "live") holds the shared copy of every game being followed.
export class LiveCache {
  constructor(state, env, fetchFn = (...a) => fetch(...a), now = () => Date.now()) {
    this.state = state;
    this.env = env;
    this.fetchFn = fetchFn;
    this.now = now;
    this.games = new Map(); // id -> { at, final, promise }
  }

  async fetch(request) {
    const ids = parseIds(new URL(request.url).searchParams.get("ids"));
    if (!ids) return new Response("bad ids", { status: 400 });
    const now = this.now();
    for (const [id, c] of this.games) if (now - c.at > FORGET_MS) this.games.delete(id);
    const out = {};
    await Promise.all(ids.map(async (id) => { out[id] = await this.game(id, now); }));
    return Response.json(out);
  }

  // the shared copy, asking ESPN again only when it is LIVE_TTL_MS old (requests that arrive
  // while ESPN is being asked wait for that same answer)
  game(id, now) {
    const c = this.games.get(id);
    if (c && (c.final || now - c.at < LIVE_TTL_MS)) return c.promise;
    const entry = { at: now, final: false, promise: null };
    entry.promise = this.load(id, now).then((wp) => { entry.final = !!(wp && wp.final); return wp; });
    this.games.set(id, entry);
    return entry.promise;
  }

  async load(id, now) {
    let d;
    try {
      const r = await this.fetchFn(`${ESPN}/summary?event=${id}`, { headers: { "User-Agent": UA } });
      if (!r.ok) return null;
      d = await r.json();
    } catch (e) {
      return null; // unknown for now; asked again after LIVE_TTL_MS
    }
    const wp = slim(d);
    const kick = Date.parse((((d.header || {}).competitions || [{}])[0] || {}).date || "");
    if (wp.final && now - kick < RECENT_MS) await this.dispatchOnce(id);
    return wp;
  }

  async dispatchOnce(id) {
    const key = `dispatched:${id}`;
    if (await this.state.storage.get(key)) return;
    await this.state.storage.put(key, this.now());
    try {
      await dispatch(this.env, this.fetchFn);
    } catch (e) {
      console.error(`final ${id}: ${e.message}`); // the 15-minute run picks the result up anyway
    }
  }
}

const allowedOrigin = (origin, env) =>
  !!origin && (String(env.ORIGINS || "").split(",").includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin));

async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const cors = allowedOrigin(origin, env) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
  if (url.pathname !== "/live") return new Response("not found", { status: 404 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  const ids = parseIds(url.searchParams.get("ids"));
  if (!ids) return new Response("ids: up to 24 ESPN game ids, comma-separated", { status: 400, headers: cors });
  const stub = env.LIVE.get(env.LIVE.idFromName("live"));
  const res = await stub.fetch(`https://live/?ids=${ids.join(",")}`);
  return new Response(res.body, { status: res.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default {
  async scheduled(_controller, env) {
    await dispatch(env);
  },
  fetch: handle,
  dispatch, // for tests/trigger.test.js
};
