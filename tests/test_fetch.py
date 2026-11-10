"""Fetcher tests: the caching rules decide when ESPN gets called, so they are tested with a
fake ESPN that records every request. Run: python3 -m unittest discover -s tests"""
import copy
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import fetch_data as F  # noqa: E402

FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "season-2026-11-09.json").read_text())


def scoreboard(games, final=True, extra_events=()):
    """ESPN scoreboard JSON for the given games, every home team winning when final."""
    events = []
    for g in games:
        status = {"name": "STATUS_FINAL", "completed": True} if final else {"name": "STATUS_SCHEDULED", "completed": False}
        comp = lambda side, tid, name, won: {
            "homeAway": side, "team": {"id": tid, "abbreviation": name},
            "winner": won if final else None, "score": ("31" if won else "17") if final else None,
        }
        events.append({"id": g["id"], "date": g["date"], "competitions": [{
            "status": {"type": status}, "neutralSite": False, "conferenceCompetition": g["conf"], "notes": [],
            "competitors": [comp("home", g["home"], g["homeName"], True), comp("away", g["away"], g["awayName"], False)],
        }]})
    return {"events": events + list(extra_events)}


class FakeESPN:
    def __init__(self, fpi_run="2026-11-09T09:00Z", final=True):
        self.urls = []
        self.fpi_run = fpi_run
        self.final = final

    def __call__(self, url, raw=False):
        self.urls.append(url)
        if "/scoreboard" in url:
            week = int(url.split("week=")[1].split("&")[0])
            return scoreboard([g for g in FIXTURE["games"] if g["week"] == week], final=self.final)
        if "/powerindex" in url:
            return {"items": [{"team": {"$ref": f".../teams/{t['id']}?lang=en"}, "lastUpdated": self.fpi_run,
                               "predictives": [{"name": "fpi", "value": t["fpi"]}]} for t in FIXTURE["teams"]]}
        if "/predictor" in url:
            return {"homeTeam": {"statistics": [{"name": "gameProjection", "value": 61.0}]}}
        if "/combiner/" in url and raw:
            return b"\x89PNG fake"
        raise AssertionError(f"unexpected ESPN call {url}")


PNG = "data:image/png;base64,iVBORw0KGgo="


def first_kickoff():
    return min(F.parse(g["date"]) for g in FIXTURE["games"] if not g["completed"])


class FetchTests(unittest.TestCase):
    def run_fetch(self, prev, now, fake, *extra, league_path=""):
        """Returns (data written, or None) and the league's page in the site (always written)."""
        with tempfile.TemporaryDirectory() as tmp:
            prev_path = Path(tmp) / "prev.json"
            prev_path.write_text(json.dumps(prev))
            out = Path(tmp) / "data.json"
            gh_out = Path(tmp) / "gh_output"
            argv = ["fetch_data.py", "--prev", str(prev_path), "--data-out", str(out), "--artifact", "",
                    "--no-exact", "--site", str(Path(tmp) / "site"), "--github-output", *extra]
            with mock.patch.object(F, "get", fake), mock.patch.object(F, "now_utc", lambda: now), \
                    mock.patch.object(sys, "argv", argv), mock.patch("builtins.print"), \
                    mock.patch.dict("os.environ", {"GITHUB_OUTPUT": str(gh_out)}):
                F.main()
            written = json.loads(out.read_text()) if out.exists() else None
            self.changed = gh_out.read_text().strip()
            index = Path(tmp) / "site" / league_path / "index.html"
            site = index.read_text() if index.exists() else None
            if site is not None:
                self.assertTrue((Path(tmp) / "site" / "favicon.svg").exists(), "favicon shipped with the site")
                self.site_data = json.loads((index.parent / "data.json").read_text())
        return written, site

    def fresh_prev(self, now):
        prev = copy.deepcopy(FIXTURE)
        prev["leagues"] = [{**l, "logo": PNG, "logoDark": PNG} for l in F.LEAGUES.values()]
        prev["meta"]["scheduleCheckedAt"] = F.iso(now - dt.timedelta(hours=1))
        prev["meta"]["fpiCheckedAt"] = F.iso(now - dt.timedelta(hours=1))
        return prev

    def test_nothing_due_means_no_calls_and_no_deploy(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        fake = FakeESPN()
        written, site = self.run_fetch(self.fresh_prev(now), now, fake)
        self.assertEqual(fake.urls, [])
        self.assertIsNone(written)
        self.assertEqual(self.changed, "changed=false")
        # the page is still written, so a deploy for another league's change carries this one too
        self.assertTrue(site)

    def test_result_not_looked_for_before_kickoff_plus_3h(self):
        now = first_kickoff() + dt.timedelta(hours=2, minutes=50)
        fake = FakeESPN()
        self.run_fetch(self.fresh_prev(now), now, fake)
        self.assertEqual(fake.urls, [])

    def test_due_game_fetches_only_its_week(self):
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        fake = FakeESPN()
        written, site = self.run_fetch(self.fresh_prev(now), now, fake)
        self.assertEqual(len(fake.urls), 1)
        self.assertIn("week=11", fake.urls[0])
        week11 = [g for g in written["games"] if g["week"] == 11]
        self.assertTrue(all(g["completed"] and g["winner"] == g["home"] for g in week11))
        self.assertTrue(all(g["pHome"] is None for g in week11), "finished games drop their prediction")
        self.assertTrue(site)
        self.assertEqual(self.changed, "changed=true")

    def test_game_still_in_progress_is_retried_next_run(self):
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        fake = FakeESPN(final=False)
        written, _ = self.run_fetch(self.fresh_prev(now), now, fake)
        self.assertEqual(len(fake.urls), 1)
        # nothing changed, so nothing is written; the next run asks again
        self.assertIsNone(written)

    def test_new_fpi_run_refetches_every_prediction(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        prev["meta"]["fpiCheckedAt"] = F.iso(now - dt.timedelta(hours=7))
        fake = FakeESPN(fpi_run="2026-11-12T09:00Z")
        written, _ = self.run_fetch(prev, now, fake)
        pending = [g for g in FIXTURE["games"] if not g["completed"]]
        self.assertEqual(sum("/powerindex" in u for u in fake.urls), 1)
        self.assertEqual(sum("/predictor" in u for u in fake.urls), len(pending))
        self.assertTrue(all(g["pHome"] == 0.61 for g in written["games"] if not g["completed"]))

    def test_same_fpi_run_keeps_predictions_but_saves_the_check(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        prev["meta"]["fpiCheckedAt"] = F.iso(now - dt.timedelta(hours=7))
        fake = FakeESPN()  # same run as the fixture
        written, _ = self.run_fetch(prev, now, fake)
        self.assertEqual([("/powerindex" in u) for u in fake.urls], [True])
        self.assertEqual(written["meta"]["fpiCheckedAt"], F.iso(now), "the check is saved so the next run skips it")

    def test_offline_build_makes_no_calls(self):
        now = first_kickoff() + dt.timedelta(days=3)  # everything would be due online
        fake = FakeESPN()
        written, site = self.run_fetch(copy.deepcopy(FIXTURE), now, fake, "--offline", "--force-build")
        self.assertEqual(fake.urls, [])
        self.assertTrue(site)
        self.assertIn('<link rel="icon" href="favicon.svg"', site)
        self.assertEqual(written["meta"]["checkedAt"], FIXTURE["meta"]["checkedAt"])


    def test_dark_logos_backfilled_once_for_older_data(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        for t in prev["teams"][:3]:
            del t["logoDark"]  # published before dark logos existed
        fake = FakeESPN()
        written, _ = self.run_fetch(prev, now, fake)
        self.assertEqual(len(fake.urls), 3)
        self.assertTrue(all("/500-dark/" in u for u in fake.urls))
        self.assertTrue(all(t["logoDark"].startswith("data:image/png;base64,") for t in written["teams"][:3]))
        # next run: nothing left to backfill
        fake2 = FakeESPN()
        self.run_fetch(written, now, fake2)
        self.assertEqual(fake2.urls, [])


    def test_sec_page_lives_under_its_path_with_every_league_in_the_nav(self):
        now = first_kickoff()
        prev = copy.deepcopy(FIXTURE)
        prev["league"] = "sec"
        written, site = self.run_fetch(prev, now, FakeESPN(), "--offline", "--force-build", "--league", "sec", league_path="sec")
        self.assertTrue(site)
        self.assertIn('<link rel="icon" href="../favicon.svg"', site)
        self.assertIn("<title>SEC Title Paths</title>", site)
        self.assertEqual(written["league"], "sec")
        self.assertEqual([(l["id"], l["name"], l["path"]) for l in self.site_data["leagues"]],
                         [("big12", "Big 12", ""), ("sec", "SEC", "sec/"), ("acc", "ACC", "acc/")])

    def test_acc_page_lives_under_acc(self):
        now = first_kickoff()
        prev = copy.deepcopy(FIXTURE)
        prev["league"] = "acc"
        written, site = self.run_fetch(prev, now, FakeESPN(), "--offline", "--force-build", "--league", "acc", league_path="acc")
        self.assertIn("<title>ACC Title Paths</title>", site)
        self.assertEqual(written["league"], "acc")

    def test_another_leagues_data_is_not_reused(self):
        now = first_kickoff()
        with self.assertRaises(SystemExit):  # Big 12 data can't seed the SEC
            self.run_fetch(copy.deepcopy(FIXTURE), now, FakeESPN(), "--offline", "--league", "sec", league_path="sec")

    def test_acc_calls_use_the_acc_group(self):
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        prev = self.fresh_prev(now)
        prev["league"] = "acc"
        fake = FakeESPN()
        self.run_fetch(prev, now, fake, "--league", "acc", league_path="acc")
        self.assertEqual(len(fake.urls), 1)
        self.assertIn("groups=1&", fake.urls[0])

    def test_sec_calls_use_the_sec_group(self):
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        prev = self.fresh_prev(now)
        prev["league"] = "sec"
        fake = FakeESPN()
        self.run_fetch(prev, now, fake, "--league", "sec", league_path="sec")
        self.assertEqual(len(fake.urls), 1)
        self.assertIn("groups=8&", fake.urls[0])


    def test_league_logos_fetched_once_and_the_big_12_carries_its_sponsor(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        del prev["leagues"]  # published before league logos existed
        fake = FakeESPN()
        written, _ = self.run_fetch(prev, now, fake)
        conf = [u for u in fake.urls if "/ncaa_conf/" in u]
        self.assertEqual(len(conf), 2 * len(F.LEAGUES), "light and dark logo per league")
        self.assertEqual(len(fake.urls), len(conf))
        for l in written["leagues"]:
            self.assertTrue(l["logo"].startswith("data:image/png;base64,"), l["id"])
            self.assertTrue(l["logoDark"].startswith("data:image/png;base64,"), l["id"])
        big12 = written["leagues"][0]
        self.assertEqual(big12["sponsor"]["name"], "Monster Energy")
        self.assertTrue(big12["sponsor"]["logo"].startswith("data:image/png;base64,iVBORw0KGgo"), "the claw, a real PNG")
        self.assertNotIn("sponsor", written["leagues"][1])
        fake2 = FakeESPN()
        self.run_fetch(written, now, fake2)
        self.assertEqual(fake2.urls, [], "kept from the previous data")


class ScoreboardParsing(unittest.TestCase):
    def test_title_game_and_non_conference_flag(self):
        games = [g for g in FIXTURE["games"] if g["week"] == 11][:2]
        title = scoreboard(games[:1])["events"][0]
        title = copy.deepcopy(title)
        title["id"] = "title"
        title["competitions"][0]["notes"] = [{"headline": "Big 12 Championship"}]
        sb = scoreboard(games, extra_events=[title])
        sb["events"][1]["competitions"][0]["conferenceCompetition"] = False
        with mock.patch.object(F, "get", lambda url, raw=False: sb):
            parsed = F.fetch_week(F.LEAGUES["big12"], 2026, 11)
        self.assertEqual([g["id"] for g in parsed], [g["id"] for g in games])
        self.assertIs(parsed[1]["confFlag"], False)

    def test_sec_title_game_is_left_out(self):
        games = [g for g in FIXTURE["games"] if g["week"] == 11][:2]
        title = copy.deepcopy(scoreboard(games[:1])["events"][0])
        title["id"] = "title"
        title["competitions"][0]["notes"] = [{"headline": "SEC Championship"}]
        sb = scoreboard(games, extra_events=[title])
        with mock.patch.object(F, "get", lambda url, raw=False: sb):
            parsed = F.fetch_week(F.LEAGUES["sec"], 2025, 15)
        self.assertNotIn("title", [g["id"] for g in parsed])

    def test_acc_title_game_is_left_out(self):
        # 2024 and 2025: ESPN's note reads "ACC Championship"
        games = [g for g in FIXTURE["games"] if g["week"] == 11][:2]
        title = copy.deepcopy(scoreboard(games[:1])["events"][0])
        title["id"] = "title"
        title["competitions"][0]["notes"] = [{"headline": "ACC Championship"}]
        sb = scoreboard(games, extra_events=[title])
        with mock.patch.object(F, "get", lambda url, raw=False: sb):
            parsed = F.fetch_week(F.LEAGUES["acc"], 2025, 15)
        self.assertNotIn("title", [g["id"] for g in parsed])

    def test_canceled_game_is_completed_without_a_winner(self):
        sb = scoreboard([g for g in FIXTURE["games"] if g["week"] == 11][:1], final=False)
        sb["events"][0]["competitions"][0]["status"]["type"] = {"name": "STATUS_CANCELED", "completed": False}
        with mock.patch.object(F, "get", lambda url, raw=False: sb):
            g = F.fetch_week(F.LEAGUES["big12"], 2026, 11)[0]
        self.assertTrue(g["completed"])
        self.assertTrue(g["canceled"])
        self.assertIsNone(g["winner"])


class Escaping(unittest.TestCase):
    def test_colors(self):
        self.assertEqual(F.hexcolor("cc0000", "666666"), "#cc0000")
        self.assertEqual(F.hexcolor('"><script>', "666666"), "#666666")
        self.assertEqual(F.hexcolor(None, "999999"), "#999999")

    def test_script_safe_round_trips_and_cannot_close_the_script(self):
        payload = json.dumps({"name": "</script><script>alert(1)</script>", "x": "a&b<!--"})
        safe = F.script_safe(payload)
        self.assertNotIn("</", safe)
        self.assertNotIn("<!--", safe)
        self.assertEqual(json.loads(safe), json.loads(payload))


if __name__ == "__main__":
    unittest.main()
