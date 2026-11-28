// Live-score helpers for worker.mjs, kept out of the Worker's main module: Cloudflare treats
// every export of that module as an entry point, and refuses to start on plain values.

export const LIVE_TTL_MS = 30e3;
export const ALLOWED_TTL_MS = 5 * 60e3; // how often the worker rereads the site's live-ids.json
export const MAX_IDS = 24; // a week's slate across a league, with room
export const WP_POINTS = 120; // as fetch_data.py: plenty for a 300px chart

// Game time at a play, in seconds from kickoff (fetch_data.py's play_seconds): 15-minute
// quarters; overtime gets two minutes a period after regulation.
function playSeconds(pl) {
  const period = (pl.period && pl.period.number) || 1;
  if (period > 4) return 3600 + (period - 4) * 120;
  const [m, s] = String((pl.clock && pl.clock.displayValue) || "15:00").split(":");
  const left = Number.isFinite(+m) && Number.isFinite(+(s || 0)) ? +m * 60 + +(s || 0) : 900;
  return (period - 1) * 900 + Math.max(0, 900 - left);
}

// Python's round(): halves go to the even neighbour, so a chart matches fetch_data.py's exactly
const roundEven = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };

// The points on the longest run of plays whose game time never goes back: ESPN files a play out of
// place now and then, and its odds belong to some other moment. fetch_data.py's in_order says
// why, and picks the same run: the same patience sort, ties going the same way.
export function inOrder(pts) {
  const tails = [], ends = [], prev = [];
  pts.forEach(([t], i) => {
    let lo = 0, hi = tails.length; // first tail greater than t (Python's bisect_right)
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] <= t) lo = mid + 1; else hi = mid; }
    prev.push(lo ? ends[lo - 1] : -1);
    tails[lo] = t; ends[lo] = i;
  });
  const keep = [];
  for (let i = ends.length ? ends[ends.length - 1] : -1; i >= 0; i = prev[i]) keep.push(i);
  return keep.reverse().map((i) => pts[i]);
}

// ESPN's game summary, cut down to what a game card draws: the same shape fetch_data.py stores
// as a game's "wp".
export function slim(d) {
  const drives = d.drives || {};
  const plays = new Map();
  for (const dr of [...(drives.previous || []), ...(drives.current ? [drives.current] : [])]) {
    for (const pl of dr.plays || []) plays.set(pl.id, pl);
  }
  let pts = [];
  for (const w of d.winprobability || []) {
    const pl = plays.get(w.playId);
    if (!pl || w.homeWinPercentage == null) continue;
    pts.push([playSeconds(pl), roundEven(w.homeWinPercentage * 1000)]);
  }
  pts = inOrder(pts);
  if (pts.length > WP_POINTS) {
    const keep = [...new Set(Array.from({ length: WP_POINTS }, (_, k) => roundEven((k * (pts.length - 1)) / (WP_POINTS - 1))))];
    pts = keep.map((k) => pts[k]);
  }
  const comp = ((d.header || {}).competitions || [{}])[0] || {};
  const stype = (comp.status || {}).type || {};
  const score = Object.fromEntries((comp.competitors || []).map((c) => [c.homeAway, c.score]));
  const num = (v) => (v == null || v === "" || !Number.isFinite(parseFloat(v)) ? null : Math.trunc(parseFloat(v)));
  // the team with the ball, while the game is on (ESPN marks neither between a score and the kickoff)
  const ball = stype.state === "in" ? (comp.competitors || []).find((c) => c.possession === true) : null;
  return { pts, final: !!stype.completed, detail: stype.shortDetail || null, homeScore: num(score.home), awayScore: num(score.away),
    state: stype.state || null, // ESPN's "pre", "in" or "post": a game can sit at "pre" past its kickoff time
    possession: ball && /^\d{1,12}$/.test(String(ball.id)) ? String(ball.id) : null };
}

export const parseIds = (s) => {
  const ids = [...new Set(String(s || "").split(",").filter(Boolean))];
  return ids.length && ids.length <= MAX_IDS && ids.every((id) => /^\d{1,12}$/.test(id)) ? ids : null;
};


// The site's live-ids.json ({ league: [ESPN game ids] }, written by fetch_data.py): the only games
// /live asks ESPN about. Anything malformed in it is skipped; null if it isn't that shape at all.
export function allowedIds(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const out = new Set();
  for (const ids of Object.values(json)) {
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && /^\d{1,12}$/.test(id)) out.add(id);
  }
  return out;
}
