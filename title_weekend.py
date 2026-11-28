#!/usr/bin/env python3
"""The title weekend page: every league's championship game on one page, at <site>/title-weekend/.

Built after fetch_data.py has written each league's data.json into the site, from those files
alone (no ESPN calls): each league's title game (data["title"]), its two teams' seasons summed up
for a tale of the tape, and for a matchup not yet set, the teams still in the running.

Usage: python3 title_weekend.py SITE_DIR
"""
import json, sys
from pathlib import Path

import fetch_data as F

PATH = "title-weekend/"


def seeds_of(d, ids):
    """{team id: 1 or 2} once the seeds are settled, from the exact odds: a team in for certain
    whose odds of being #1 are 1 is #1, the other #2. {} while either is open."""
    e = d.get("exact") or {}
    if not e.get("teams") or e.get("skipped"):
        return {}
    by = {t["id"]: t for t in e["teams"]}
    if not all(i in by and by[i]["p"] >= 1 for i in ids):
        return {}
    one = [i for i in ids if (by[i].get("first") or 0) >= 0.9995]
    if len(one) != 1:
        return {}
    return {i: 1 if i == one[0] else 2 for i in ids}


def team_season(d, tid, cfp):
    """One team's season from the league's games: records, scoring, its last five, and its wins
    over teams in the CFP committee's latest Top 25."""
    won = lost = cw = cl = pf = pa = n = top25 = 0
    results = []
    for g in d["games"]:
        if tid not in (g["home"], g["away"]) or not g["completed"] or g.get("canceled") or not g.get("winner"):
            continue
        home = g["home"] == tid
        opp = g["away"] if home else g["home"]
        win = g["winner"] == tid
        won += win; lost += not win
        if g.get("conf"):
            cw += win; cl += not win
        us, them = (g["homeScore"], g["awayScore"]) if home else (g["awayScore"], g["homeScore"])
        if us is not None and them is not None:
            pf += us; pa += them; n += 1
        if win and isinstance(cfp.get(opp), int):
            top25 += 1
        results.append({"id": g["id"], "week": g["week"], "opp": opp, "oppName": g["awayName"] if home else g["homeName"],
                        "home": home, "neutral": bool(g.get("neutral")), "win": win, "us": us, "them": them, "conf": bool(g.get("conf"))})
    results.sort(key=lambda r: r["week"])
    return {"w": won, "l": lost, "cw": cw, "cl": cl, "ppg": round(pf / n, 1) if n else None, "papg": round(pa / n, 1) if n else None,
            "top25": top25, "results": results}


def contenders(d):
    """The teams still in the running for a matchup not yet set, likeliest first, with their odds."""
    snap = F.odds_snapshot(d) or {}
    return sorted(((tid, p) for tid, p in snap.items() if p > 0), key=lambda x: -x[1])


def league_entry(d):
    lg = next(l for l in d["leagues"] if l["id"] == d["league"])
    t = d.get("title")
    cfp = (d.get("cfp") or {}).get("ranks") or {}
    teams = {x["id"]: x for x in d["teams"]}
    out = {"id": lg["id"], "name": lg["name"], "path": lg["path"], "logo": lg.get("logo"), "logoDark": lg.get("logoDark"),
           "sponsor": lg.get("sponsor"), "title": t, "seasonOver": all(g["completed"] for g in d["games"])}
    ids = [t["home"], t["away"]] if t and not t.get("tbd") else []
    run = [] if ids else contenders(d)
    keep = set(ids) | {tid for tid, _ in run}
    out["teams"] = [{k: v for k, v in x.items() if k in ("id", "abbr", "name", "short", "color", "alt", "logo", "logoDark", "fpi")}
                    for tid, x in teams.items() if tid in keep]
    out["contenders"] = [{"id": tid, "p": p} for tid, p in run]
    out["seeds"] = seeds_of(d, ids) if ids else {}
    out["seasons"] = {tid: team_season(d, tid, cfp) for tid in ids if tid in teams}
    out["cfp"] = cfp
    return out


def build(site):
    root = Path(site)
    leagues, fetched, season, live_url = [], [], None, F.live_url()
    for lg in F.LEAGUES.values():
        p = root / lg["path"] / "data.json"
        if not p.exists():
            continue
        d = json.loads(p.read_text())
        season = season or d.get("season")
        fetched.append(d.get("fetchedAt") or "")
        leagues.append(league_entry(d))
    if not leagues:
        sys.exit(f"no league data under {root}")
    data = {"season": season, "fetchedAt": max(fetched), "leagues": leagues}
    out = root / PATH
    out.mkdir(parents=True, exist_ok=True)
    # page_data moves team logos out to files under <root>/logos/, as the league pages do
    for e in leagues:
        e["teams"] = json.loads(F.page_data({"teams": e["teams"]}, root, "../"))["teams"]
    (out / "page-data.json").write_text(json.dumps(data, separators=(",", ":")))
    here = Path(__file__).resolve().parent
    tpl = (here / "title.html").read_text().replace('/*__LIVE__*/""', json.dumps(live_url), 1)
    desc = ("Every Power Four and Pac-12 championship game on one page: kickoff, TV, the line, a tale of the tape, "
            "and live scores and win probability on title weekend.")
    tags = [("name", "description", desc), ("property", "og:type", "website"), ("property", "og:site_name", "Title Paths"),
            ("property", "og:title", "Title Weekend"), ("property", "og:description", desc),
            ("property", "og:url", F.SITE_URL + PATH), ("name", "twitter:card", "summary")]
    meta = "".join(f'<meta {k}="{F.html.escape(v)}" content="{F.html.escape(c)}">' for k, v, c in tags) \
        + f'<link rel="canonical" href="{F.html.escape(F.SITE_URL + PATH)}">'
    (out / "index.html").write_text(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
        "<link rel=\"icon\" href=\"../favicon.svg\" type=\"image/svg+xml\">" + meta + F.ANALYTICS + "</head><body>\n"
        + tpl + "\n</body></html>\n")
    print(f"wrote {out}/index.html + page-data.json ({sum(1 for e in leagues if e['title'])} title games)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(sys.argv[1])
