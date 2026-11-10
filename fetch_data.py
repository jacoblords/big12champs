#!/usr/bin/env python3
"""Incremental, schedule-aware fetch of one conference's data from ESPN's public JSON APIs.

Visitors never call ESPN. This script runs on a timer (GitHub Actions), starts from the
previously published data.json, and only calls ESPN for things that can have changed:

  results      a game's week is re-fetched once kickoff + 3h has passed and it isn't final
  schedule     weeks with unplayed games are re-fetched once a day (kickoff times move)
  FPI          checked every 6h; when ESPN's model run changes, predictions are re-fetched
  predictions  fetched for unplayed games when missing or when the FPI run changed
  teams/logos  fetched once

Usage:
  python3 fetch_data.py [--league big12|sec|acc] [--season 2026] [--prev PATH_OR_URL] [--data-out FILE] [--site DIR] [--artifact FILE]
                        [--force-build] [--github-output]
Exits 0 either way; writes changed=true|false to $GITHUB_OUTPUT with --github-output.
"""
import argparse, base64, datetime as dt, json, os, re, subprocess, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football"
STANDINGS = "https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings"
# Each league's page lives at <site>/<path>. group: ESPN's conference id. The page's nav lists
# these in this order; the tiebreak rules live in engine.js under the same ids.
# sponsor: a logo shown in front of the league's name (in the repo, inlined like the ESPN logos).
LEAGUES = {
    "big12": {"id": "big12", "name": "Big 12", "path": "", "group": 4,
              "sponsor": {"name": "Monster Energy", "file": "monster-claw.png"}},
    "sec": {"id": "sec", "name": "SEC", "path": "sec/", "group": 8},
    "acc": {"id": "acc", "name": "ACC", "path": "acc/", "group": 1},
    "big10": {"id": "big10", "name": "Big Ten", "path": "big10/", "group": 5},
}
SCHEMA = 3  # 3: games carry ESPN's conference flag
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


def png_uri(png):
    return "data:image/png;base64," + base64.b64encode(png).decode()


def fetch_logo(tid, dark=False, kind="ncaa"):
    """80px logo as a data URI: a team's, or a conference's with kind="ncaa_conf" (tid = its
    ESPN group). dark=True is ESPN's version made for dark backgrounds."""
    folder = "500-dark" if dark else "500"
    try:
        png = get(f"https://a.espncdn.com/combiner/i?img=/i/teamlogos/{kind}/{folder}/{tid}.png&w=80&h=80", raw=True)
        return png_uri(png)
    except Exception:
        return None


def league_entries(prev_leagues, offline):
    """Every league for the page's nav: names, paths, logos. ESPN's conference logos are fetched
    once and then kept from the previous data; sponsor logos come from the repo."""
    old = {l["id"]: l for l in prev_leagues or []}
    out, fetched = [], 0
    for lg in LEAGUES.values():
        e = {k: v for k, v in lg.items() if k != "sponsor"}
        for key, dark in (("logo", False), ("logoDark", True)):
            e[key] = old.get(lg["id"], {}).get(key)
            if not e[key] and not offline:
                e[key] = fetch_logo(lg["group"], dark=dark, kind="ncaa_conf"); fetched += 1
        if "sponsor" in lg:
            e["sponsor"] = {"name": lg["sponsor"]["name"], "logo": png_uri((HERE / lg["sponsor"]["file"]).read_bytes())}
        out.append(e)
    return out, fetched


def fetch_teams(league, season):
    st = get(f"{STANDINGS}?group={league['group']}&season={season}")
    entries = (st.get("standings") or st["children"][0]["standings"])["entries"]

    def one(e):
        tid = e["team"]["id"]
        t = get(f"{SITE}/teams/{tid}")["team"]
        return {"id": tid, "abbr": t["abbreviation"], "name": t["displayName"],
                "short": t.get("shortDisplayName") or t["location"],
                "color": hexcolor(t.get("color"), "666666"), "alt": hexcolor(t.get("alternateColor"), "999999"),
                "logo": fetch_logo(tid), "logoDark": fetch_logo(tid, dark=True)}
    return pmap(one, entries)


def fetch_week(league, season, week):
    """Every game involving one of the league's teams that week, in one call."""
    d = get(f"{SITE}/scoreboard?groups={league['group']}&seasontype=2&week={week}&dates={season}&limit=200")
    out = []
    for e in d.get("events", []):
        c = e["competitions"][0]
        notes = " ".join(n.get("headline", "") for n in c.get("notes") or [])
        if (c.get("type") or {}).get("type") == "conference-championship" or f"{league['name']} Championship" in notes:
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
            # ESPN's own flag: two league teams can meet in a non-conference game
            # (e.g. Arizona at Kansas State in 2024, scheduled before Arizona joined).
            "confFlag": c.get("conferenceCompetition"),
            "completed": done or canceled, "canceled": canceled, "postponed": stype.get("name") == "STATUS_POSTPONED",
            "winner": winner, "homeScore": sc(h), "awayScore": sc(a),
        })
    return out


def fetch_calendar(league, season):
    d = get(f"{SITE}/scoreboard?groups={league['group']}&seasontype=2&week=1&dates={season}&limit=1")
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
    ap.add_argument("--league", choices=sorted(LEAGUES), default="big12")
    ap.add_argument("--season", type=int, default=int(os.environ.get("SEASON", "2026")))
    ap.add_argument("--prev", default=None, help="previous data (default: --data-out)")
    ap.add_argument("--data-out", default=None, help="where to keep the full data file (default: data.json, data-<league>.json)")
    ap.add_argument("--site", default=None, help="site root: writes <league path>/index.html + data.json under it, every run")
    ap.add_argument("--artifact", default=None, help="write a self-contained page here ('' to skip; default <league>-path.html)")
    ap.add_argument("--force-build", action="store_true", help="rebuild pages even if data is unchanged")
    ap.add_argument("--github-output", action="store_true")
    ap.add_argument("--offline", action="store_true", help="no ESPN calls: rebuild from --prev only (tests, CI)")
    ap.add_argument("--no-exact", action="store_true", help="skip the exact enumeration")
    args = ap.parse_args()
    league = LEAGUES[args.league]
    if args.data_out is None:
        args.data_out = str(HERE / ("data.json" if league["id"] == "big12" else f"data-{league['id']}.json"))
    if args.artifact is None:
        args.artifact = str(HERE / f"{league['id']}-path.html")
    now = now_utc()

    prev = load_prev(args.prev or args.data_out)
    if not prev or prev.get("schema") != SCHEMA or prev.get("season") != args.season \
            or prev.get("league", "big12") != league["id"]:
        prev = None
    meta = dict(prev["meta"]) if prev else {}
    teams = prev["teams"] if prev else None
    games = {g["id"]: g for g in prev["games"]} if prev else {}
    fpi = prev.get("fpi", {}) if prev else {}
    calendar = prev.get("calendar") if prev else None
    changed = []
    leagues, fetched = league_entries(prev.get("leagues") if prev else None, args.offline)
    if fetched and prev:
        changed.append(f"{fetched} league logos")

    if args.offline:
        if not prev:
            sys.exit("--offline needs a usable --prev data file")
    elif not teams:
        teams = fetch_teams(league, args.season); changed.append("teams")
    else:
        # one-time backfill for data published before dark-mode logos existed
        missing = [t for t in teams if "logoDark" not in t]
        if missing:
            for t, uri in zip(missing, pmap(lambda t: fetch_logo(t["id"], dark=True), missing)):
                t["logoDark"] = uri
            changed.append(f"dark logos for {len(missing)} teams")
    if not calendar and not args.offline:
        calendar = fetch_calendar(league, args.season); changed.append("calendar")

    # Which weeks need a scoreboard call?
    weeks = set()
    if args.offline:
        pass
    elif not games:
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
        for wk_games in pmap(lambda w: fetch_week(league, args.season, w), sorted(weeks)):
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
    if not args.offline and (not fpi or not fpi_at or now - fpi_at >= FPI_TTL):
        fpi, run = fetch_fpi(args.season)
        meta["fpiCheckedAt"] = iso(now)
        if run != meta.get("fpiRun"):
            fpi_stale = True
            meta["fpiRun"] = run
            changed.append(f"FPI run {run}")

    pending = [g for g in games.values() if not g["completed"]]
    need = [] if args.offline else [g["id"] for g in pending if fpi_stale or g.get("pHome") is None]
    if need:
        print(f"predictions for {len(need)} games")
        for gid, p in pmap(fetch_prediction, need):
            if p is not None and games[gid].get("pHome") != p:
                changed.append(f"prediction {gid}")
            games[gid]["pHome"] = p if p is not None else games[gid].get("pHome")
            games[gid]["predAt"] = iso(now)

    team_ids = {t["id"] for t in teams}
    for t in teams:
        t["fpi"] = fpi.get(t["id"])
    for g in games.values():
        both_in = g["home"] in team_ids and g["away"] in team_ids
        g["conf"] = both_in and (g.get("confFlag") if g.get("confFlag") is not None else True)
        g["homeFBS"] = g["home"] in fpi
        g["awayFBS"] = g["away"] in fpi

    due = [parse(g["date"]) + RESULT_DELAY for g in games.values() if not g["completed"]]
    if not args.offline:
        meta["checkedAt"] = iso(now)
    meta["nextResultCheck"] = iso(min(due)) if due else None
    if changed:
        meta["updatedAt"] = iso(now)
    meta["espnCalls"] = calls

    data = {"schema": SCHEMA, "league": league["id"], "leagues": leagues, "season": args.season, "fetchedAt": meta.get("updatedAt", iso(now)), "meta": meta,
            "calendar": calendar, "teams": teams, "fpi": fpi, "games": sorted(games.values(), key=lambda g: g["date"])}
    if prev and prev.get("exact"):
        data["exact"] = prev["exact"]  # exact.js reuses it when its inputs haven't changed
    print(f"{calls} ESPN calls; {len(changed)} changes" + (f": {', '.join(changed[:8])}{' …' if len(changed) > 8 else ''}" if changed else ""))

    # A check that found nothing new still has to be saved, or the next run repeats it.
    checks_moved = not args.offline and (
        prev is None or any(meta.get(k) != prev["meta"].get(k) for k in ("scheduleCheckedAt", "fpiCheckedAt")))
    build = bool(changed) or checks_moved or args.force_build
    if build:
        out = Path(args.data_out)
        out.write_text(json.dumps(data, indent=1))
        if args.no_exact:
            data.pop("exact", None)
        else:
            # Exact odds by enumerating every finish (Node; ~40s for 24 games, skipped above 26).
            try:
                subprocess.run(["node", str(HERE / "exact.js"), str(out)], check=True)
                data = json.loads(out.read_text())
            except (OSError, subprocess.CalledProcessError) as e:
                print(f"exact odds unavailable ({e}); the page will use simulation")
                data.pop("exact", None)
    payload = json.dumps(data, separators=(",", ":"))
    tpl = ((HERE / "app.html").read_text().replace("/*__ENGINE__*/", (HERE / "engine.js").read_text())
           .replace("<title>Title Paths</title>", f"<title>{league['name']} Title Paths</title>", 1))
    # Written every run, changed or not: one deploy carries every league's page, so a run that
    # only changed the SEC still has to put the Big 12 page in the site.
    if args.site:
        root = Path(args.site); root.mkdir(parents=True, exist_ok=True)
        site = root / league["path"]; site.mkdir(parents=True, exist_ok=True)
        up = "../" * league["path"].count("/")
        (site / "data.json").write_text(payload)
        (root / "favicon.svg").write_text((HERE / "favicon.svg").read_text())
        (site / "index.html").write_text("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
                                         "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
                                         f"<link rel=\"icon\" href=\"{up}favicon.svg\" type=\"image/svg+xml\">"
                                         "</head><body>\n" + tpl + "\n</body></html>\n")
        print(f"wrote {site}/index.html + data.json")
    if build and args.artifact:
        Path(args.artifact).write_text(tpl.replace("/*__DATA__*/null", script_safe(payload)))
        print(f"wrote {args.artifact}")
    if args.github_output and os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"changed={'true' if build else 'false'}\n")


if __name__ == "__main__":
    main()
