// Live-score helpers for worker.mjs, kept out of the Worker's main module: Cloudflare treats
// every export of that module as an entry point, and refuses to start on plain values.

export const LIVE_TTL_MS = 30e3;
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

// ESPN's game summary, cut down to what a game card draws: the same shape fetch_data.py stores
// as a game's "wp".
export function slim(d) {
  const drives = d.drives || {};
  const plays = new Map();
  for (const dr of [...(drives.previous || []), ...(drives.current ? [drives.current] : [])]) {
    for (const pl of dr.plays || []) plays.set(pl.id, pl);
  }
  let pts = [], last = 0;
  for (const w of d.winprobability || []) {
    const pl = plays.get(w.playId);
    if (!pl || w.homeWinPercentage == null) continue;
    last = Math.max(last, playSeconds(pl));
    pts.push([last, roundEven(w.homeWinPercentage * 1000)]);
  }
  if (pts.length > WP_POINTS) {
    const keep = [...new Set(Array.from({ length: WP_POINTS }, (_, k) => roundEven((k * (pts.length - 1)) / (WP_POINTS - 1))))];
    pts = keep.map((k) => pts[k]);
  }
  const comp = ((d.header || {}).competitions || [{}])[0] || {};
  const stype = (comp.status || {}).type || {};
  const score = Object.fromEntries((comp.competitors || []).map((c) => [c.homeAway, c.score]));
  const num = (v) => (v == null || v === "" || !Number.isFinite(parseFloat(v)) ? null : Math.trunc(parseFloat(v)));
  return { pts, final: !!stype.completed, detail: stype.shortDetail || null, homeScore: num(score.home), awayScore: num(score.away) };
}

export const parseIds = (s) => {
  const ids = [...new Set(String(s || "").split(",").filter(Boolean))];
  return ids.length && ids.length <= MAX_IDS && ids.every((id) => /^\d{1,12}$/.test(id)) ? ids : null;
};

