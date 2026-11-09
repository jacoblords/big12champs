#!/usr/bin/env python3
"""Incremental, schedule-aware fetch of Big 12 data from ESPN's public JSON APIs.

Visitors never call ESPN. This script runs on a timer (GitHub Actions), starts from the
previously published data.json, and only calls ESPN for things that can have changed:

  results      a game's week is re-fetched once kickoff + 3h has passed and it isn't final
  schedule     weeks with unplayed games are re-fetched once a day (kickoff times move)
  FPI          checked every 6h; when ESPN's model run changes, predictions are re-fetched
  predictions  fetched for unplayed games when missing or when the FPI run changed
  teams/logos  fetched once

Usage:
  python3 fetch_data.py [--season 2026] [--prev PATH_OR_URL] [--site DIR] [--artifact FILE]
                        [--force-build] [--github-output]
Exits 0 either way; writes changed=true|false to $GITHUB_OUTPUT with --github-output.
"""
import argparse, base64, datetime as dt, json, os, re, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football"
STANDINGS = "https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings"
BIG12_GROUP = 4
SCHEMA = 2
RESULT_DELAY = dt.timedelta(hours=3)      # don't look for a final score before kickoff + 3h
SCHEDULE_TTL = dt.timedelta(hours=24)
FPI_TTL = dt.timedelta(hours=6)
HERE = Path(__file__).resolve().parent

calls = 0


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%MZ")


def parse(s):
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    if len(s) == 22:  # 2026-11-14T17:00+00:00
        s = s[:16] + ":00" + s[16:]
    return dt.datetime.fromisoformat(s)


def get(url, raw=False):
    """Polite GET: identifies itself, retries 429/5xx with backoff, never hammers."""
    global calls
    for attempt in range(4):
        calls += 1
        req = urllib.request.Request(url, headers={"User-Agent": "big12-title-paths (github actions; hourly-ish)"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            return data if raw else json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
            wait = int(e.headers.get("Retry-After") or 0) or 2 ** attempt * 5
        except urllib.error.URLError:
            if attempt == 3:
                raise
            wait = 2 ** attempt * 5
        time.sleep(wait)


def pmap(fn, items, workers=4):
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


def hexcolor(v, default):
    """ESPN team colors are bare hex; anything else is replaced so it can't break out of a style attribute."""
    v = (v or "").strip().lstrip("#")
    return "#" + (v if re.fullmatch(r"[0-9a-fA-F]{3,8}", v) else default)


def script_safe(payload):
    """JSON embedded in <script> can't contain a literal '</script>' or '<!--'."""
    return payload.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def load_prev(src):
    if not src:
        return None
    try:
        if src.startswith("http"):
            return json.loads(urllib.request.urlopen(src, timeout=30).read())
        p = Path(src)
        return json.loads(p.read_text()) if p.exists() else None
    except Exception as e:  # first deploy: nothing published yet
        print(f"no previous data ({e}); starting fresh")
        return None


def fetch_teams(season):
    st = get(f"{STANDINGS}?group={BIG12_GROUP}&season={season}")
    entries = (st.get("standings") or st["children"][0]["standings"])["entries"]

    def one(e):
        tid = e["team"]["id"]
        t = get(f"{SITE}/teams/{tid}")["team"]
        logo = None
        try:
            png = get(f"https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/{tid}.png&w=80&h=80", raw=True)
            logo = "data:image/png;base64," + base64.b64encode(png).decode()
        except Exception:
            pass
        return {"id": tid, "abbr": t["abbreviation"], "name": t["displayName"],
                "short": t.get("shortDisplayName") or t["location"],
                "color": hexcolor(t.get("color"), "666666"), "alt": hexcolor(t.get("alternateColor"), "999999"),
                "logo": logo}
    return pmap(one, entries)


def fetch_week(season, week):
    """Every game involving a Big 12 team that week, in one call."""
    d = get(f"{SITE}/scoreboard?groups={BIG12_GROUP}&seasontype=2&week={week}&dates={season}&limit=200")
    out = []
    for e in d.get("events", []):
        c = e["competitions"][0]
        notes = " ".join(n.get("headline", "") for n in c.get("notes") or [])
        if (c.get("type") or {}).get("type") == "conference-championship" or "Big 12 Championship" in notes:
            continue  # title game: excluded from records and the 12-game win count
        comp = {x["homeAway"]: x for x in c["competitors"]}
        h, a = comp["home"], comp["away"]
        stype = c["status"]["type"]
        done = bool(stype.get("completed"))
        canceled = stype.get("name") in ("STATUS_CANCELED", "STATUS_FORFEIT") and not done
        winner = None
        if done:
            winner = h["team"]["id"] if h.get("winner") else a["team"]["id"] if a.get("winner") else None
        sc = lambda x: int(float(x["score"])) if done and x.get("score") not in (None, "") else None
        out.append({
            "id": e["id"], "week": week, "date": e["date"],
            "home": h["team"]["id"], "away": a["team"]["id"],
            "homeName": h["team"].get("abbreviation"), "awayName": a["team"].get("abbreviation"),
            "neutral": bool(c.get("neutralSite")),
            "completed": done or canceled, "canceled": canceled, "postponed": stype.get("name") == "STATUS_POSTPONED",
            "winner": winner, "homeScore": sc(h), "awayScore": sc(a),
        })
    return out


def fetch_calendar(season):
    d = get(f"{SITE}/scoreboard?groups={BIG12_GROUP}&seasontype=2&week=1&dates={season}&limit=1")
    reg = [c for c in d["leagues"][0]["calendar"] if str(c.get("value")) == "2"][0]
    return [{"week": int(e["value"]), "start": e["startDate"], "end": e["endDate"]} for e in reg["entries"]]


def fetch_fpi(season):
    pi = get(f"{CORE}/seasons/{season}/powerindex?limit=300")
    fpi, run = {}, None
    for it in pi["items"]:
        tid = it["team"]["$ref"].split("/teams/")[1].split("?")[0]
        fpi[tid] = next((p.get("value") for p in it["predictives"] if p["name"] == "fpi"), None)
        run = run or it.get("lastUpdated")
    return fpi, run


def fetch_prediction(gid):
    try:
        p = get(f"{CORE}/events/{gid}/competitions/{gid}/predictor")
        stats = {s["name"]: s.get("value") for s in p["homeTeam"]["statistics"]}
        v = stats.get("gameProjection")
        return gid, (round(v / 100.0, 4) if v is not None else None)
    except Exception as e:
        print(f"  prediction {gid} unavailable: {e}")
        return gid, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=int(os.environ.get("SEASON", "2026")))
    ap.add_argument("--prev", default=str(HERE / "data.json"))
    ap.add_argument("--site", default=None, help="write index.html + data.json here (fetch mode)")
    ap.add_argument("--artifact", default=str(HERE / "big12-path.html"), help="write a self-contained page here ('' to skip)")
    ap.add_argument("--force-build", action="store_true", help="rebuild pages even if data is unchanged")
    ap.add_argument("--github-output", action="store_true")
    args = ap.parse_args()
    now = now_utc()

    prev = load_prev(args.prev)
    if not prev or prev.get("schema") != SCHEMA or prev.get("season") != args.season:
        prev = None
    meta = dict(prev["meta"]) if prev else {}
    teams = prev["teams"] if prev else None
    games = {g["id"]: g for g in prev["games"]} if prev else {}
    fpi = prev.get("fpi", {}) if prev else {}
    calendar = prev.get("calendar") if prev else None
    changed = []

    if not teams:
        teams = fetch_teams(args.season); changed.append("teams")
    if not calendar:
        calendar = fetch_calendar(args.season); changed.append("calendar")

    # Which weeks need a scoreboard call?
    weeks = set()
    if not games:
        weeks = {c["week"] for c in calendar}
    else:
        for g in games.values():
            if g["completed"] or g.get("postponed"):
                continue
            if parse(g["date"]) + RESULT_DELAY <= now:
                weeks.add(g["week"])  # should be final by now
        sched_at = parse(meta.get("scheduleCheckedAt"))
        if not sched_at or now - sched_at >= SCHEDULE_TTL:
            weeks |= {g["week"] for g in games.values() if not g["completed"]}
            meta["scheduleCheckedAt"] = iso(now)
    if weeks:
        print(f"scoreboards for weeks {sorted(weeks)}")
        for wk_games in pmap(lambda w: fetch_week(args.season, w), sorted(weeks)):
            for ng in wk_games:
                old = games.get(ng["id"])
                ng["pHome"] = None if ng["completed"] else (old or {}).get("pHome")
                ng["predAt"] = (old or {}).get("predAt")
                keys = ("date", "completed", "winner", "homeScore", "awayScore", "canceled", "postponed")
                if not old or any(old.get(k) != ng.get(k) for k in keys):
                    changed.append(f"game {ng['awayName']}@{ng['homeName']}")
                games[ng["id"]] = {**(old or {}), **ng}
        meta.setdefault("scheduleCheckedAt", iso(now))

    # FPI: tiebreaker f stand-in, FBS membership, and the clock for ESPN's prediction model.
    fpi_stale = False
    fpi_at = parse(meta.get("fpiCheckedAt"))
    if not fpi or not fpi_at or now - fpi_at >= FPI_TTL:
        fpi, run = fetch_fpi(args.season)
        meta["fpiCheckedAt"] = iso(now)
        if run != meta.get("fpiRun"):
            fpi_stale = True
            meta["fpiRun"] = run
            changed.append(f"FPI run {run}")

    pending = [g for g in games.values() if not g["completed"]]
    need = [g["id"] for g in pending if fpi_stale or g.get("pHome") is None]
    if need:
        print(f"predictions for {len(need)} games")
        for gid, p in pmap(fetch_prediction, need):
            if p is not None and games[gid].get("pHome") != p:
                changed.append(f"prediction {gid}")
            games[gid]["pHome"] = p if p is not None else games[gid].get("pHome")
            games[gid]["predAt"] = iso(now)

    for t in teams:
        t["fpi"] = fpi.get(t["id"])
    for g in games.values():
        g["conf"] = g["home"] in {t["id"] for t in teams} and g["away"] in {t["id"] for t in teams}
        g["homeFBS"] = g["home"] in fpi
        g["awayFBS"] = g["away"] in fpi

    due = [parse(g["date"]) + RESULT_DELAY for g in games.values() if not g["completed"]]
    meta["checkedAt"] = iso(now)
    meta["nextResultCheck"] = iso(min(due)) if due else None
    if changed:
        meta["updatedAt"] = iso(now)
    meta["espnCalls"] = calls

    data = {"schema": SCHEMA, "season": args.season, "fetchedAt": meta.get("updatedAt", iso(now)), "meta": meta,
            "calendar": calendar, "teams": teams, "fpi": fpi, "games": sorted(games.values(), key=lambda g: g["date"])}
    print(f"{calls} ESPN calls; {len(changed)} changes" + (f": {', '.join(changed[:8])}{' …' if len(changed) > 8 else ''}" if changed else ""))

    # A check that found nothing new still has to be saved, or the next run repeats it.
    checks_moved = prev is None or any(meta.get(k) != prev["meta"].get(k) for k in ("scheduleCheckedAt", "fpiCheckedAt"))
    build = bool(changed) or checks_moved or args.force_build
    if build:
        payload = json.dumps(data, separators=(",", ":"))
        (HERE / "data.json").write_text(json.dumps(data, indent=1))
        tpl = (HERE / "app.html").read_text().replace("/*__ENGINE__*/", (HERE / "engine.js").read_text())
        if args.site:
            site = Path(args.site); site.mkdir(parents=True, exist_ok=True)
            (site / "data.json").write_text(payload)
            (site / "index.html").write_text("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
                                             "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
                                             "</head><body>\n" + tpl + "\n</body></html>\n")
            print(f"wrote {site}/index.html + data.json")
        if args.artifact:
            Path(args.artifact).write_text(tpl.replace("/*__DATA__*/null", script_safe(payload)))
            print(f"wrote {args.artifact}")
    if args.github_output and os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"changed={'true' if build else 'false'}\n")


if __name__ == "__main__":
    main()
