"""The title weekend page's build: every league's title game from the data.json files the league
steps wrote, with each team's season summed up. Run: python3 -m unittest discover -s tests"""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import fetch_data as F  # noqa: E402
import title_weekend as TW  # noqa: E402

FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "season-2026-11-09.json").read_text())
PNG = "data:image/png;base64,iVBORw0KGgo="


def league_data(league, title=None, exact=None, games=None):
    d = copy.deepcopy(FIXTURE)
    d["league"] = league
    d["leagues"] = [{**{k: v for k, v in l.items() if k != "sponsor"}, "logo": PNG, "logoDark": PNG} for l in F.LEAGUES.values()]
    d["teams"] = [{**t, "logo": PNG, "logoDark": PNG} for t in d["teams"]]
    if games is not None:
        d["games"] = games
    if title:
        d["title"] = title
    if exact:
        d["exact"] = exact
    return d


def title_of(home, away, **kw):
    return {"id": "401869533", "week": 14, "date": "2026-12-05T01:00Z", "home": home, "away": away, "homeName": "H", "awayName": "A",
            "completed": False, "winner": None, "homeScore": None, "awayScore": None, "tbd": False, "name": "Big 12 Championship",
            "leaders": {}, "timeValid": True, **kw}


class TitleWeekendBuild(unittest.TestCase):
    def build(self, leagues):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for d in leagues:
                path = root / F.LEAGUES[d["league"]]["path"]
                path.mkdir(parents=True, exist_ok=True)
                (path / "data.json").write_text(json.dumps(d))
            from unittest import mock
            with mock.patch("builtins.print"), mock.patch.dict("os.environ", {"LIVE_URL": "https://live.example.workers.dev"}):
                TW.build(str(root))
            out = root / "title-weekend"
            return json.loads((out / "page-data.json").read_text()), (out / "index.html").read_text(), {p.name for p in (root / "logos").glob("*.png")}

    def test_a_set_matchup_carries_both_seasons_seeds_and_no_contenders(self):
        t = FIXTURE["teams"]
        a, b = t[0]["id"], t[1]["id"]
        exact = {"teams": [{"id": a, "p": 1, "first": 1}, {"id": b, "p": 1, "first": 0}] + [{"id": x["id"], "p": 0, "first": 0} for x in t[2:]]}
        data, page, logos = self.build([league_data("big12", title_of(b, a), exact)])
        [lg] = data["leagues"]
        self.assertEqual((lg["id"], lg["name"], lg["path"]), ("big12", "Big 12", ""))
        self.assertEqual(lg["seeds"], {a: 1, b: 2})
        self.assertEqual(lg["contenders"], [])
        self.assertEqual({x["id"] for x in lg["teams"]}, {a, b}, "only the two teams' names and logos")
        self.assertTrue(all(x["logo"].startswith("../logos/") for x in lg["teams"]), "logos moved out to files")
        self.assertTrue(logos)
        # each season from the league's finished games
        mine = [g for g in FIXTURE["games"] if a in (g["home"], g["away"]) and g["completed"] and g.get("winner")]
        s = lg["seasons"][a]
        self.assertEqual(s["w"] + s["l"], len(mine))
        self.assertEqual(s["w"], sum(g["winner"] == a for g in mine))
        self.assertEqual(s["cw"] + s["cl"], sum(1 for g in mine if g["conf"]))
        pts = [(g["homeScore"] if g["home"] == a else g["awayScore"]) for g in mine]
        self.assertAlmostEqual(s["ppg"], round(sum(pts) / len(pts), 1))
        self.assertEqual([r["week"] for r in s["results"]], sorted(r["week"] for r in s["results"]))
        self.assertIn('"https://live.example.workers.dev/"', page, "the live worker's address")
        self.assertIn('<link rel="canonical" href="https://titlepaths.com/title-weekend/">', page)
        self.assertIn('<script defer src="https://static.cloudflareinsights.com/beacon.min.js"', page)

    def test_seeds_wait_until_settled(self):
        t = FIXTURE["teams"]
        a, b = t[0]["id"], t[1]["id"]
        open_ = {"teams": [{"id": a, "p": 1, "first": 0.6}, {"id": b, "p": 1, "first": 0.4}]}
        data, _, _ = self.build([league_data("big12", title_of(b, a), open_)])
        self.assertEqual(data["leagues"][0]["seeds"], {})
        data, _, _ = self.build([league_data("big12", title_of(b, a))])  # no exact odds at all
        self.assertEqual(data["leagues"][0]["seeds"], {})

    def test_a_matchup_still_to_be_set_lists_whoever_is_still_in_it(self):
        t = FIXTURE["teams"]
        exact = {"teams": [{"id": t[0]["id"], "p": 0.4}, {"id": t[1]["id"], "p": 0.9}, {"id": t[2]["id"], "p": 0.7}]
                 + [{"id": x["id"], "p": 0} for x in t[3:]]}
        tbd = title_of("-1", "-2", tbd=True, homeName="TBD", awayName="TBD")
        data, _, _ = self.build([league_data("big12", tbd, exact), league_data("sec")])
        lg = data["leagues"][0]
        self.assertEqual([c["id"] for c in lg["contenders"]], [t[1]["id"], t[2]["id"], t[0]["id"]])
        self.assertEqual(lg["seasons"], {})
        self.assertIsNone(data["leagues"][1]["title"], "a league ESPN hasn't listed a title game for yet")


if __name__ == "__main__":
    unittest.main()
