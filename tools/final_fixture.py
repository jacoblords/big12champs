#!/usr/bin/env python3
"""Build a test fixture from a finished season: every game final, logos dropped to keep it small.

  python3 tools/final_fixture.py sec 2025      # writes tests/fixtures/final-sec-2025.json

Fetches from ESPN through fetch_data.py (about 70 calls, under a minute), into a temp folder, so
your own data files are untouched. The league must already be in LEAGUES in fetch_data.py.
"""
import json, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    league, season = sys.argv[1], int(sys.argv[2])
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "data.json"
        subprocess.run([sys.executable, str(HERE / "fetch_data.py"), "--league", league, "--season", str(season),
                        "--data-out", str(raw), "--artifact", "", "--no-exact"], check=True)
        d = json.loads(raw.read_text())
    open_games = [g for g in d["games"] if not g["completed"]]
    if open_games:
        sys.exit(f"{len(open_games)} games aren't final yet (e.g. {open_games[0]['awayName']} at {open_games[0]['homeName']})")
    keep = ("id", "abbr", "name", "short", "color", "alt", "fpi")
    teams = [{**{k: t[k] for k in keep}, "logo": None} for t in d["teams"]]
    games = [{k: v for k, v in g.items() if k != "predAt"} for g in d["games"]]
    # Big 12 fixtures predate the league field; data without one is read as Big 12.
    out = {"season": season, "teams": teams, "games": games}
    if league != "big12":
        out = {"league": league, **out}
    name = f"final-{season}.json" if league == "big12" else f"final-{league}-{season}.json"
    path = HERE / "tests" / "fixtures" / name
    path.write_text(json.dumps(out, separators=(",", ":")))
    conf = sum(g["conf"] for g in games)
    per_team = {t["id"]: 0 for t in teams}
    for g in games:
        if g["conf"]:
            per_team[g["home"]] += 1; per_team[g["away"]] += 1
    print(f"wrote {path.relative_to(HERE)}: {len(teams)} teams, {len(games)} games, {conf} conference games "
          f"({min(per_team.values())}-{max(per_team.values())} per team)")


if __name__ == "__main__":
    main()
