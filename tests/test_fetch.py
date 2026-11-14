"""Fetcher tests: the caching rules decide when ESPN gets called, so they are tested with a
fake ESPN that records every request. Run: python3 -m unittest discover -s tests"""
import copy
import datetime as dt
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import fetch_data as F  # noqa: E402

FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "season-2026-11-09.json").read_text())
# Saved before the scoreboard kept TV and spreads; tests start from data that already has them.
FIXTURE["meta"]["scheduleFields"] = F.SCHEDULE_FIELDS
for _g in FIXTURE["games"]:
    _g.update(timeValid=True, tv=None, spread=None, overUnder=None, venue=None, city=None)


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


def summary(final, home_pct=(0.6, 0.7, 0.9)):
    """ESPN's game summary: a win-probability point per play, and the score and clock."""
    plays = [{"id": f"p{k}", "period": {"number": k + 1}, "clock": {"displayValue": "7:30"}} for k in range(len(home_pct))]
    return {"drives": {"previous": [{"plays": plays}]},
            "winprobability": [{"playId": f"p{k}", "homeWinPercentage": p} for k, p in enumerate(home_pct)],
            "header": {"competitions": [{"status": {"type": {"completed": final, "shortDetail": "Final" if final else "3rd 7:30"}},
                                         "competitors": [{"homeAway": "home", "score": "24"}, {"homeAway": "away", "score": "10"}]}]}}


class FakeESPN:
    """Records every call. Game summaries (in-game win probability) go in .summaries, so the
    caching tests can count the rest on their own."""
    def __init__(self, fpi_run="2026-11-09T09:00Z", final=True, summary_final=None):
        self.urls = []
        self.summaries = []
        self.fpi_run = fpi_run
        self.final = final
        self.summary_final = final if summary_final is None else summary_final
        self.rank_calls = 0
        # ESPN's rankings: the AP poll, then the CFP committee's, ranking the fixture's first two teams
        t = FIXTURE["teams"]
        self.rankings = {"rankings": [
            {"name": "AP Top 25", "type": "ap", "ranks": [{"current": 1, "team": {"id": t[2]["id"]}}]},
            {"name": "Playoff Committee Rankings", "type": "cfp", "date": "2026-11-10T08:00Z", "occurrence": {"number": 11},
             "ranks": [{"current": 7, "team": {"id": t[0]["id"]}}, {"current": 19, "team": {"id": t[1]["id"]}}]}]}

    def __call__(self, url, raw=False):
        if "/summary?event=" in url:
            self.summaries.append(url.split("event=")[1])
            return summary(self.summary_final)
        self.urls.append(url)
        if "/scoreboard" in url:
            week = int(url.split("week=")[1].split("&")[0])
            return scoreboard([g for g in FIXTURE["games"] if g["week"] == week], final=self.final)
        if "/powerindex" in url:
            return {"items": [{"team": {"$ref": f".../teams/{t['id']}?lang=en"}, "lastUpdated": self.fpi_run,
                               "predictives": [{"name": "fpi", "value": t["fpi"]}]} for t in FIXTURE["teams"]]}
        if "/rankings" in url:
            self.rank_calls += 1
            return self.rankings
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
                self.assertIn("static.cloudflareinsights.com/beacon.min.js", site.split("</head>")[0], "analytics beacon in the head")
                self.site_data = json.loads((index.parent / "data.json").read_text())
                self.page_data = json.loads((index.parent / "page-data.json").read_text())
                self.logo_files = {p.name: p.read_bytes() for p in (Path(tmp) / "site" / "logos").glob("*.png")}
        return written, site

    def fresh_prev(self, now):
        prev = copy.deepcopy(FIXTURE)
        prev["leagues"] = [{**l, "logo": PNG, "logoDark": PNG} for l in F.LEAGUES.values()]
        prev["meta"]["scheduleCheckedAt"] = F.iso(now - dt.timedelta(hours=1))
        prev["meta"]["fpiCheckedAt"] = F.iso(now - dt.timedelta(hours=1))
        prev["meta"]["cfpCheckedAt"] = F.iso(now - dt.timedelta(hours=1))
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
        fake = FakeESPN(summary_final=False)  # ESPN hasn't called it final either
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

    def test_a_game_first_final_keeps_what_its_result_did_to_the_race(self):
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        prev = self.fresh_prev(now)
        pending = [g["id"] for g in prev["games"] if not g["completed"]]
        g0 = next(g for g in prev["games"] if g["id"] == pending[0])
        teams = [t["id"] for t in prev["teams"]]
        # exact odds before the run: the first team 40%, 60% if g0's home team wins, 10% if not;
        # the second moves a third of a point (not kept); the rest don't move
        def team(i, tid):
            p = 0.4 if i == 0 else 0.2
            games = [{"pH": 0.6, "pA": 0.1} if (i == 0 and k == 0) else {"pH": p + (0.003 if i == 1 else 0), "pA": p} for k in range(len(pending))]
            return {"id": tid, "p": p, "games": games}
        prev["exact"] = {"gameIds": pending, "teams": [team(i, tid) for i, tid in enumerate(teams)]}
        written, _ = self.run_fetch(prev, now, FakeESPN())  # every home team wins
        g = next(x for x in written["games"] if x["id"] == g0["id"])
        self.assertTrue(g["completed"])
        self.assertEqual(g["moved"], {teams[0]: [0.4, 0.6]})
        # kept as is on later runs, and nothing for a game that was already final
        again, _ = self.run_fetch(written, now + dt.timedelta(minutes=15), FakeESPN())
        self.assertEqual(next(x for x in (again or written)["games"] if x["id"] == g0["id"])["moved"], {teams[0]: [0.4, 0.6]})
        self.assertFalse(any("moved" in x for x in prev["games"] if x["completed"] and x["id"] not in pending))

    def test_game_moves_from_a_simulated_league_and_none_without_a_view(self):
        prev = {"sim": {"gameIds": ["g1", "g2"], "teamIds": ["a", "b"],
                        "totals": {"nSims": 1000, "appear": [500, 300],
                                   # cond: per game, [away wins, home wins] runs, then appearances by team
                                   "cond": {"n": [600, 400, 300, 700], "appear": [420, 150, 80, 150, 0, 0, 0, 0]}}}}
        self.assertEqual(F.game_moves(prev, "g1", False), {"a": [0.5, 0.7], "b": [0.3, 0.25]})
        self.assertIsNone(F.game_moves(prev, "g1", True), "under 500 runs for that result")
        self.assertIsNone(F.game_moves(prev, "g9", True))
        self.assertIsNone(F.game_moves({}, "g1", True))

    def test_a_finished_game_keeps_its_last_line(self):
        # ESPN's scoreboard has no odds for a game that's over
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        prev = self.fresh_prev(now)
        g0 = next(g for g in prev["games"] if g["week"] == 11 and not g["completed"])
        g0.update(spread="COLO -3.5", overUnder=58.5)
        written, _ = self.run_fetch(prev, now, FakeESPN())
        g = next(x for x in written["games"] if x["id"] == g0["id"])
        self.assertTrue(g["completed"])
        self.assertEqual((g["spread"], g["overUnder"]), ("COLO -3.5", 58.5))

    def test_game_still_in_progress_is_retried_next_run(self):
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        fake = FakeESPN(final=False)
        written, _ = self.run_fetch(self.fresh_prev(now), now, fake)
        self.assertEqual(len(fake.urls), 1)
        # no result yet (only the live win probability is new); the next run asks again
        self.assertTrue(all(not g["completed"] for g in written["games"] if g["week"] == 11))
        self.assertTrue(all(g.get("wp") for g in written["games"] if g["week"] == 11 and F.parse(g["date"]) <= now))

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

    def finished_season(self, fpi_run):
        """The fixture with every game final, as of the Wednesday after the last weekend."""
        prev = copy.deepcopy(FIXTURE)
        for g in prev["games"]:
            if not g["completed"]:
                g.update(completed=True, winner=g["home"], homeScore=31, awayScore=17, pHome=None)
        last = max(F.parse(g["date"]) for g in prev["games"])
        now = last + dt.timedelta(days=4)
        prev["leagues"] = [{**l, "logo": PNG, "logoDark": PNG} for l in F.LEAGUES.values()]
        prev["meta"].update(scheduleCheckedAt=F.iso(now - dt.timedelta(hours=1)),
                            fpiCheckedAt=F.iso(now - dt.timedelta(hours=7)), fpiRun=F.iso(fpi_run(last)),
                            cfpCheckedAt=F.iso(now - dt.timedelta(hours=1)))
        return prev, now

    def test_fpi_frozen_once_it_has_run_after_the_last_game(self):
        # title games and bowls move FPI; the tiebreak uses it as of the last regular-season weekend
        prev, now = self.finished_season(lambda last: last + dt.timedelta(hours=28))
        fake = FakeESPN(fpi_run="2026-12-07T09:00Z")
        written, site = self.run_fetch(prev, now, fake)
        self.assertEqual(fake.urls, [])
        self.assertIsNone(written)
        self.assertTrue(site)

    def test_fpi_still_fetched_until_it_has_run_after_the_last_game(self):
        prev, now = self.finished_season(lambda last: last - dt.timedelta(days=5))
        fake = FakeESPN(fpi_run="2026-11-30T09:00Z")
        written, _ = self.run_fetch(prev, now, fake)
        self.assertEqual(["/powerindex" in u for u in fake.urls], [True])
        self.assertEqual(written["meta"]["fpiRun"], "2026-11-30T09:00Z")

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


    def test_each_league_page_has_its_own_description_and_link_preview(self):
        now = first_kickoff()
        for lid, name, path in (("big12", "Big 12", ""), ("big10", "Big Ten", "big10/")):
            prev = copy.deepcopy(FIXTURE)
            prev["league"] = lid
            _, site = self.run_fetch(prev, now, FakeESPN(), "--offline", "--force-build", "--league", lid,
                                     league_path=path.rstrip("/"))
            head = site.split("</head>")[0]
            desc = f"Every {name} team&#x27;s odds of reaching the {name} Championship Game"
            self.assertIn(f'<meta name="description" content="{desc}', head)
            self.assertIn(f'<meta property="og:description" content="{desc}', head)
            self.assertIn(f'<meta property="og:title" content="{name} Title Paths">', head)
            self.assertIn(f'<meta property="og:url" content="https://titlepaths.com/{path}">', head)
            self.assertIn(f'<link rel="canonical" href="https://titlepaths.com/{path}">', head)
            self.assertEqual(head.count('name="description"'), 1)

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
                         [("big12", "Big 12", ""), ("sec", "SEC", "sec/"), ("acc", "ACC", "acc/"),
                          ("big10", "Big Ten", "big10/"), ("pac12", "Pac-12", "pac12/")])

    def test_page_data_moves_team_logos_to_files_and_data_json_keeps_them(self):
        now = first_kickoff()
        for league, path, up in (("big12", "", ""), ("sec", "sec", "../")):
            prev = copy.deepcopy(FIXTURE)
            prev["league"] = league
            prev["leagues"] = [{**l, "logo": PNG, "logoDark": PNG} for l in F.LEAGUES.values()]
            light, dark = b"\x89PNG light", b"\x89PNG dark"
            for t in prev["teams"]:
                t["logo"], t["logoDark"] = F.png_uri(light), F.png_uri(dark)
            prev["teams"][1]["logoDark"] = None
            written, site = self.run_fetch(prev, now, FakeESPN(), "--offline", "--force-build", "--league", league, league_path=path)
            # data.json is the next run's starting point: still self-contained
            self.assertTrue(all(t["logo"].startswith("data:image/png;base64,") for t in self.site_data["teams"]))
            # the page's copy names files, each written once under the site root
            names = {t["logo"] for t in self.page_data["teams"]} | {t["logoDark"] for t in self.page_data["teams"]}
            self.assertEqual(len(names - {None}), 2, "one file per distinct image")
            self.assertIsNone(self.page_data["teams"][1]["logoDark"])
            for n in names - {None}:
                self.assertRegex(n, r"^" + re.escape(up) + r"logos/[0-9a-f]{16}\.png$")
                self.assertIn(self.logo_files[n.split("/")[-1]], (light, dark))
            # header logos are sized by their shape, so they stay inline (no shift when they load)
            self.assertEqual(self.page_data["leagues"], self.site_data["leagues"])
            self.assertEqual({k: v for k, v in self.page_data.items() if k != "teams"},
                             {k: v for k, v in self.site_data.items() if k != "teams"})

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

    def test_big_ten_page_lives_under_big10_and_calls_use_group_5(self):
        now = first_kickoff()
        prev = copy.deepcopy(FIXTURE)
        prev["league"] = "big10"
        written, site = self.run_fetch(prev, now, FakeESPN(), "--offline", "--force-build", "--league", "big10", league_path="big10")
        self.assertIn("<title>Big Ten Title Paths</title>", site)
        self.assertEqual(written["league"], "big10")
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        prev = self.fresh_prev(now)
        prev["league"] = "big10"
        fake = FakeESPN()
        self.run_fetch(prev, now, fake, "--league", "big10", league_path="big10")
        self.assertEqual(len(fake.urls), 1)
        self.assertIn("groups=5&", fake.urls[0])

    def test_cfp_rankings_are_fetched_every_six_hours_and_kept_between(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        prev["meta"]["cfpCheckedAt"] = F.iso(now - F.CFP_TTL)
        fake = FakeESPN()
        written, _ = self.run_fetch(prev, now, fake)
        self.assertEqual(fake.rank_calls, 1)
        t = FIXTURE["teams"]
        # the committee's ranking, not the AP poll's
        self.assertEqual(written["cfp"], {"date": "2026-11-10T08:00Z", "week": 11, "ranks": {t[0]["id"]: 7, t[1]["id"]: 19}})
        self.assertEqual(self.changed, "changed=true")
        # within six hours: no call, and the rankings carry over
        later = now + dt.timedelta(hours=1)
        fake2 = FakeESPN()
        again, _ = self.run_fetch(written, later, fake2, "--force-build")
        self.assertEqual(fake2.rank_calls, 0)
        self.assertEqual(again["cfp"], written["cfp"])
        # the same ranking again changes nothing
        fake3 = FakeESPN()
        self.run_fetch(written, now + F.CFP_TTL, fake3)
        self.assertEqual(fake3.rank_calls, 1)
        self.assertNotIn("CFP", self.changed)

    def test_cfp_rankings_frozen_once_the_selection_day_ranking_is_in(self):
        # Every game final: checks go on until a ranking dated a week after the last regular-season
        # game (selection day, after the title games), then stop.
        prev, now = self.finished_season(lambda last: last + dt.timedelta(hours=28))
        last = max(F.parse(g["date"]) for g in prev["games"])
        prev["meta"]["cfpCheckedAt"] = F.iso(now - F.CFP_TTL)
        prev["cfp"] = {"date": F.iso(last + dt.timedelta(days=3)), "week": 14, "ranks": {"1": 1}}
        fake = FakeESPN()
        self.run_fetch(copy.deepcopy(prev), now, fake)
        self.assertEqual(fake.rank_calls, 1)
        prev["cfp"]["date"] = F.iso(last + dt.timedelta(days=8))
        fake = FakeESPN()
        self.run_fetch(prev, now + dt.timedelta(days=10), fake)
        self.assertEqual(fake.rank_calls, 0)

    def test_no_cfp_ranking_yet_means_no_cfp_field(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        del prev["meta"]["cfpCheckedAt"]
        fake = FakeESPN()
        fake.rankings = {"rankings": [{"name": "AP Top 25", "type": "ap", "ranks": [{"current": 1, "team": {"id": "1"}}]}]}
        written, _ = self.run_fetch(prev, now, fake)
        self.assertEqual(fake.rank_calls, 1)
        self.assertNotIn("cfp", written)
        self.assertIn("cfpCheckedAt", written["meta"])

    def test_pac12_flex_week_games_are_not_conference_games(self):
        # The Pac-12's week-13 flex games pair two of its teams, and ESPN flags them as conference
        # games, but they don't count in the standings (lastConfWeek 12). Earlier weeks still count.
        now = first_kickoff()
        prev = copy.deepcopy(FIXTURE)
        prev["league"] = "pac12"
        last = max(g["week"] for g in prev["games"] if g["confFlag"])
        written, site = self.run_fetch(prev, now, FakeESPN(), "--offline", "--force-build", "--league", "pac12", league_path="pac12")
        self.assertIn("<title>Pac-12 Title Paths</title>", site)
        late = [g for g in written["games"] if g["week"] > 12 and g["confFlag"]]
        early = [g for g in written["games"] if g["week"] <= 12 and g["confFlag"]]
        self.assertTrue(late and early, f"fixture has flagged games on both sides of week 12 (last {last})")
        self.assertFalse(any(g["conf"] for g in late))
        self.assertTrue(all(g["conf"] for g in early))
        now = first_kickoff() + dt.timedelta(hours=3, minutes=5)
        prev = self.fresh_prev(now)
        prev["league"] = "pac12"
        fake = FakeESPN()
        self.run_fetch(prev, now, fake, "--league", "pac12", league_path="pac12")
        self.assertIn("groups=9&", fake.urls[0])

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


    def test_data_from_before_tv_and_spreads_rereads_every_unplayed_week_once(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        del prev["meta"]["scheduleFields"]
        fake = FakeESPN(final=False)
        written, _ = self.run_fetch(prev, now, fake)
        weeks = sorted({g["week"] for g in FIXTURE["games"] if not g["completed"]})
        self.assertEqual(sorted(int(u.split("week=")[1].split("&")[0]) for u in fake.urls if "/scoreboard" in u), weeks)
        self.assertEqual(written["meta"]["scheduleFields"], F.SCHEDULE_FIELDS)
        fake = FakeESPN(final=False)
        self.run_fetch(written, now, fake)
        self.assertEqual(fake.urls, [], "and not again on the next run")

    def with_odds(self, prev, p):
        prev["exact"] = {"teams": [{"id": t["id"], "p": p} for t in prev["teams"]]}
        return prev

    def test_a_new_week_starts_from_the_odds_published_before_it(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.with_odds(self.fresh_prev(now), 0.25)
        fake = FakeESPN()
        written, _ = self.run_fetch(prev, now, fake)
        self.assertEqual(fake.urls, [])
        self.assertEqual(self.changed, "changed=true")
        self.assertEqual(written["baseline"], {"week": F.current_week(FIXTURE["calendar"], now),
                                               "at": prev["meta"]["checkedAt"],
                                               "odds": {t["id"]: 0.25 for t in prev["teams"]}})
        self.assertEqual(self.page_data["baseline"], written["baseline"], "the page gets it")

    def test_the_week_keeps_its_starting_odds_as_the_odds_move(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.with_odds(self.fresh_prev(now), 0.4)
        start = {"week": F.current_week(FIXTURE["calendar"], now), "at": "2026-11-09T21:15Z", "odds": {"x": 0.25}}
        prev["baseline"] = start
        written, _ = self.run_fetch(prev, now, FakeESPN())
        self.assertIsNone(written, "nothing new to save")
        self.assertEqual(self.site_data["baseline"], start)
        # the next week replaces it
        later = now + dt.timedelta(days=7)
        prev = self.with_odds(self.fresh_prev(later), 0.4)
        prev["baseline"] = start
        prev["meta"]["nextResultCheck"] = None
        for g in prev["games"]:
            if F.parse(g["date"]) < later:
                g.update(completed=True, winner=g["home"], pHome=None)
        written, _ = self.run_fetch(prev, later, FakeESPN())
        self.assertEqual(written["baseline"]["week"], start["week"] + 1)
        self.assertEqual(set(written["baseline"]["odds"].values()), {0.4})

    def test_a_simulated_league_starts_the_week_from_its_precomputed_odds(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        ids = [t["id"] for t in prev["teams"]]
        prev["exact"] = {"skipped": "too many"}
        prev["sim"] = {"teamIds": ids, "totals": {"nSims": 4, "appear": [k % 5 for k in range(len(ids))]}}
        written, _ = self.run_fetch(prev, now, FakeESPN())
        self.assertEqual(written["baseline"]["odds"], {tid: (k % 5) / 4 for k, tid in enumerate(ids)})

    def test_a_long_shot_starts_the_week_with_its_tiny_odds_not_zero(self):
        prev = {"exact": {"teams": [{"id": "asu", "p": 4.1548e-05}, {"id": "wvu", "p": 7.152043e-09},
                                    {"id": "ku", "p": 0.0}, {"id": "utah", "p": 0.92213456}]}}
        self.assertEqual(F.odds_snapshot(prev), {"asu": 4.155e-05, "wvu": 7.152e-09, "ku": 0.0, "utah": 0.9221})

    def test_offline_builds_keep_the_week_start_as_it_is(self):
        now = first_kickoff() - dt.timedelta(hours=1)
        prev = self.with_odds(self.fresh_prev(now), 0.25)
        written, _ = self.run_fetch(prev, now, FakeESPN(), "--offline", "--force-build")
        self.assertNotIn("baseline", written)

    def test_win_probability_for_this_weeks_games_once_they_kick_off_until_final(self):
        kick = first_kickoff()
        week11 = [g for g in FIXTURE["games"] if g["week"] == 11 and not g["completed"]]
        started = lambda now: {g["id"] for g in week11 if F.parse(g["date"]) <= now}
        # before kickoff: nothing
        fake = FakeESPN()
        self.run_fetch(self.fresh_prev(kick - dt.timedelta(minutes=5)), kick - dt.timedelta(minutes=5), fake)
        self.assertEqual(fake.summaries, [])
        # under way: the games that have kicked off, and the series is saved
        now = kick + dt.timedelta(hours=1)
        fake = FakeESPN(final=False)
        written, _ = self.run_fetch(self.fresh_prev(now), now, fake)
        self.assertEqual(set(fake.summaries), started(now))
        self.assertEqual(self.changed, "changed=true")
        g = next(x for x in written["games"] if x["id"] == fake.summaries[0])
        self.assertEqual(g["wp"], {"pts": [[450, 600], [1350, 700], [2250, 900]], "final": False,
                                   "detail": "3rd 7:30", "homeScore": 24, "awayScore": 10})
        # asked again next run while it's on; once ESPN says final, never again
        fake = FakeESPN(final=False, summary_final=True)
        written, _ = self.run_fetch(written, now, fake)
        self.assertEqual(set(fake.summaries), started(now))
        fake = FakeESPN(final=False)
        self.run_fetch(written, now, fake)
        self.assertEqual(fake.summaries, [])

    def test_a_game_espn_calls_final_has_its_result_read_at_once(self):
        now = first_kickoff() + dt.timedelta(hours=1)  # well before kickoff + 3h
        fake = FakeESPN(final=True, summary_final=True)
        written, _ = self.run_fetch(self.fresh_prev(now), now, fake)
        self.assertEqual([u for u in fake.urls if "/scoreboard" in u and "week=11" in u].__len__(), 1)
        done = [g for g in written["games"] if g["week"] == 11 and F.parse(g["date"]) <= now]
        self.assertTrue(done and all(g["completed"] and g["winner"] == g["home"] for g in done))
        # still being played (ESPN hasn't called it): no scoreboard call before kickoff + 3h
        fake = FakeESPN(final=False, summary_final=False)
        self.run_fetch(self.fresh_prev(now), now, fake)
        self.assertEqual([u for u in fake.urls if "/scoreboard" in u], [])

    def test_live_url_reaches_the_pages_only_as_an_https_origin(self):
        now = first_kickoff() - dt.timedelta(minutes=5)
        cases = [("https://titlepaths-trigger.example.workers.dev", '"https://titlepaths-trigger.example.workers.dev/"'),
                 ("", '""'), ("http://plain.example/", '""'), ('https://x.example/";alert(1);//', '""')]
        for value, expect in cases:
            with mock.patch.dict("os.environ", {"LIVE_URL": value}):
                _, site = self.run_fetch(self.fresh_prev(now), now, FakeESPN())
            self.assertIn(f"const LIVE_URL = {expect};", site, value)

    def test_win_probability_skips_unset_kickoffs_and_other_weeks(self):
        now = first_kickoff() + dt.timedelta(hours=1)
        prev = self.fresh_prev(now)
        for g in prev["games"]:
            if g["week"] == 11:
                g["timeValid"] = False
        fake = FakeESPN(final=False)
        self.run_fetch(prev, now, fake)
        self.assertEqual(fake.summaries, [])

    def test_play_times_and_thinning(self):
        self.assertEqual(F.play_seconds({"period": {"number": 2}, "clock": {"displayValue": "10:00"}}), 1200)
        self.assertEqual(F.play_seconds({"period": {"number": 6}}), 3600 + 240)
        many = summary(True, [k / 500 for k in range(500)])
        for k, pl in enumerate(many["drives"]["previous"][0]["plays"]):
            pl["period"] = {"number": 1}
        with mock.patch.object(F, "get", lambda url, raw=False: many):
            _, wp = F.fetch_winprob("1")
        self.assertEqual(len(wp["pts"]), F.WP_POINTS)
        self.assertEqual(wp["pts"][0][1], 0)
        self.assertEqual(wp["pts"][-1][1], 998)

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

    def test_tv_spread_venue_and_unset_kickoff_times(self):
        games = [g for g in FIXTURE["games"] if g["week"] == 11][:2]
        sb = scoreboard(games, final=False)
        c = sb["events"][0]["competitions"][0]
        c.update(broadcast="FOX", odds=[{"details": "TCU -10.5", "overUnder": 44.5}],
                 venue={"fullName": "Amon G. Carter Stadium", "address": {"city": "Fort Worth", "state": "TX"}})
        c2 = sb["events"][1]["competitions"][0]
        c2.update(timeValid=False, broadcasts=[{"names": ["ESPN+"]}, {"names": ["ESPN+", "Big 12 Now"]}])
        with mock.patch.object(F, "get", lambda url, raw=False: sb):
            a, b = F.fetch_week(F.LEAGUES["big12"], 2026, 11)
        self.assertEqual((a["tv"], a["spread"], a["overUnder"], a["venue"], a["city"], a["timeValid"]),
                         ("FOX", "TCU -10.5", 44.5, "Amon G. Carter Stadium", "Fort Worth, TX", True))
        self.assertEqual((b["tv"], b["spread"], b["overUnder"], b["venue"], b["city"], b["timeValid"]),
                         ("ESPN+, Big 12 Now", None, None, None, None, False))

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
