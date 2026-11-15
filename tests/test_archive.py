"""archive.py: the data-history branch's copies of the published data, and restoring from them.
Run: python3 -m unittest discover -s tests"""
import base64
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import archive as A  # noqa: E402
import fetch_data as F  # noqa: E402

FIXTURES = {"big12": "season-2026-11-09.json", "sec": "sec-season-2026-11-09.json",
            "acc": "acc-season-2026-11-09.json", "big10": "big10-season-2026-11-10.json",
            "pac12": "pac12-season-2026-11-13.json"}
# two different 1x1 PNGs: a team logo and its dark version
PNG1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
PNG2 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def published(league):
    """A league's fixture as the site publishes it: logos inlined, exact odds for every team."""
    d = json.loads((ROOT / "tests" / "fixtures" / FIXTURES[league]).read_text())
    d["league"] = league
    for t in d["teams"]:
        t["logo"], t["logoDark"] = F.png_uri(PNG1), F.png_uri(PNG2)
    d["leagues"] = [{"id": league, "logo": F.png_uri(PNG2), "sponsor": {"name": "S", "logo": F.png_uri(PNG1)}}]
    n = len(d["teams"])
    d["exact"] = {"teams": [{"id": t["id"], "p": round(1 / n, 6)} for t in d["teams"]]}
    return d


def write_site(site, datas):
    for league, d in datas.items():
        out = site / F.LEAGUES[league]["path"] / "data.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(d, separators=(",", ":")))


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.site, self.history = self.dir / "site", self.dir / "history"
        self.datas = {l: published(l) for l in FIXTURES}
        write_site(self.site, self.datas)

    def tearDown(self):
        self.tmp.cleanup()

    def rows(self):
        return [json.loads(l) for l in (self.history / "odds.jsonl").read_text().splitlines()]

    def test_restore_gives_back_the_published_files_byte_for_byte(self):
        self.assertEqual(A.record(self.site, self.history), list(F.LEAGUES))
        A.restore(self.history, self.dir / "out")
        for lg in F.LEAGUES.values():
            self.assertEqual((self.dir / "out" / lg["path"] / "data.json").read_text(),
                             (self.site / lg["path"] / "data.json").read_text(), lg["id"])

    def test_history_keeps_logos_as_files_once_and_one_key_per_line(self):
        A.record(self.site, self.history)
        self.assertEqual(sorted(p.name for p in (self.history / "logos").iterdir()),
                         sorted(A.slim(F.png_uri(p), self.history)[len("logos/"):] for p in (PNG1, PNG2)))
        text = (self.history / "sec" / "data.json").read_text()
        self.assertNotIn("data:image", text)
        self.assertGreater(text.count("\n"), 100)
        d = json.loads(text)
        self.assertRegex(d["teams"][0]["logo"], A.LOGO)
        self.assertEqual(d["games"], self.datas["sec"]["games"])  # nothing but the logos changes

    def test_unchanged_data_records_nothing_and_logs_no_new_odds(self):
        A.record(self.site, self.history)
        self.assertEqual([r["league"] for r in self.rows()], list(F.LEAGUES))
        self.assertEqual(A.record(self.site, self.history), [])
        self.assertEqual(len(self.rows()), 5)

    def test_odds_log_gets_a_line_only_for_the_league_whose_odds_moved(self):
        A.record(self.site, self.history)
        sec = copy.deepcopy(self.datas["sec"])
        sec["exact"]["teams"][0]["p"] = 0.98765
        sec["meta"]["updatedAt"] = "2026-11-14T22:05Z"
        acc = copy.deepcopy(self.datas["acc"])
        acc["meta"]["espnCalls"] = 99  # a change that leaves the odds as they were
        write_site(self.site, {"sec": sec, "acc": acc})
        self.assertEqual(A.record(self.site, self.history), ["sec", "acc"])
        last = self.rows()[-1]
        self.assertEqual(len(self.rows()), 6)
        self.assertEqual((last["league"], last["at"], last["week"]), ("sec", "2026-11-14T22:05Z", 11))
        self.assertEqual(last["odds"][sec["exact"]["teams"][0]["id"]], 0.9877)

    def test_odds_log_row_uses_simulated_odds_and_skips_a_file_without_any(self):
        d = self.datas["big10"]
        ids = [t["id"] for t in d["teams"]]
        sim = {**d, "exact": {"skipped": "over the 180s budget"},
               "sim": {"teamIds": ids, "totals": {"nSims": 4, "appear": [1] + [0] * (len(ids) - 1)}}}
        self.assertEqual(A.odds_row(sim)["odds"][ids[0]], 0.25)
        self.assertIsNone(A.odds_row({**d, "exact": {"skipped": "x"}}))

    def test_restore_refuses_history_missing_a_league(self):
        A.record(self.site, self.history)
        (self.history / "pac12" / "data.json").unlink()
        with self.assertRaises(SystemExit):
            A.restore(self.history, self.dir / "out")
        self.assertFalse((self.dir / "out").exists())

    def test_only_inlined_pngs_and_their_paths_are_touched(self):
        d = {"a": "logos/notahash.png", "b": "data:image/svg+xml;base64,AAAA", "c": [1, None, "x"]}
        self.assertEqual(A.slim(d, self.history), d)
        self.assertEqual(A.unslim(d, self.history), d)


class TrendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.log = self.dir / "odds.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def log_rows(self, *rows):
        self.log.write_text("".join(json.dumps(r) + "\n" for r in rows))

    def data(self, at, odds, baseline=None):
        d = {"league": "sec", "meta": {"updatedAt": at}, "calendar": [],
             "exact": {"teams": [{"id": k, "p": v} for k, v in odds.items()]}}
        if baseline:
            d["baseline"] = baseline
        return d

    def test_week_start_then_the_log_then_the_odds_about_to_publish(self):
        self.log_rows({"at": "2026-11-15T03:00Z", "league": "sec", "week": 11, "odds": {"1": 0.5, "2": 0.5}},
                      {"at": "2026-11-15T01:00Z", "league": "big12", "week": 11, "odds": {"9": 1.0}},
                      {"at": "2026-11-15T05:00Z", "league": "sec", "week": 11, "odds": {"1": 0.6, "2": 0.4}})
        d = self.data("2026-11-15T06:30Z", {"1": 0.9, "2": 0.1},
                      baseline={"week": 11, "at": "2026-11-13T10:16Z", "odds": {"1": 0.3, "2": 0.7}})
        rows = A.trend_rows(self.log, d, self.dir / 'none')
        self.assertEqual([r["at"] for r in rows], ["2026-11-13T10:16Z", "2026-11-15T03:00Z", "2026-11-15T05:00Z", "2026-11-15T06:30Z"])
        tr = A.trend(rows)
        self.assertEqual(tr["teams"], {"1": [300, 500, 600, 900], "2": [700, 500, 400, 100]})
        self.assertEqual(tr["gaps"], [0])  # the week's start to the log's first row: unrecorded
        self.assertEqual(tr["t"][0] * 60, int(F.parse("2026-11-13T10:16Z").timestamp()))

    def test_odds_already_logged_and_a_later_baseline_add_nothing(self):
        self.log_rows({"at": "2026-11-15T03:00Z", "league": "sec", "week": 11, "odds": {"1": 0.5}})
        d = self.data("2026-11-15T03:00Z", {"1": 0.5}, baseline={"week": 12, "at": "2026-11-16T07:00Z", "odds": {"1": 0.5}})
        self.assertEqual(len(A.trend_rows(self.log, d, self.dir / 'none')), 1)

    def test_no_log_yet_still_charts_what_is_published(self):
        d = self.data("2026-11-15T03:00Z", {"1": 0.25}, baseline={"week": 11, "at": "2026-11-13T10:16Z", "odds": {"1": 0.5}})
        tr = A.trend(A.trend_rows(self.dir / "missing.jsonl", d, self.dir / "none"))
        self.assertEqual((tr["teams"], tr["gaps"]), ({"1": [500, 250]}, []))  # no log: nothing went unrecorded

    def test_backfill_fills_in_before_the_log_and_closes_the_gap(self):
        back = self.dir / "back.jsonl"
        back.write_text("".join(json.dumps(r) + "\n" for r in [
            {"at": "2026-11-13T10:16Z", "league": "sec", "week": 11, "odds": {"1": 0.3}},
            {"at": "2026-11-14T20:09Z", "league": "sec", "week": 11, "odds": {"1": 0.45}},
            {"at": "2026-11-14T20:09Z", "league": "acc", "week": 11, "odds": {"7": 1.0}},
            {"at": "2026-11-15T04:00Z", "league": "sec", "week": 11, "odds": {"1": 0.9}}]))  # after the log began: ignored
        self.log_rows({"at": "2026-11-15T03:00Z", "league": "sec", "week": 11, "odds": {"1": 0.5}})
        d = self.data("2026-11-15T03:00Z", {"1": 0.5}, baseline={"week": 11, "at": "2026-11-13T10:16Z", "odds": {"1": 0.3}})
        tr = A.trend(A.trend_rows(self.log, d, back))
        self.assertEqual((tr["teams"], tr["gaps"]), ({"1": [300, 450, 500]}, []))
        # the backfill this repo carries starts each league at its week-start odds
        for lg in F.LEAGUES:
            rows = A.read_rows(A.BACKFILL, lg)
            self.assertTrue(rows and rows[0]["week"] == 11 and rows == sorted(rows, key=lambda r: r["at"]), lg)

    def test_rounding_drops_repeats_and_teams_out_all_along_but_keeps_long_shots_in(self):
        rows = [{"at": "2026-11-15T0%d:00Z" % h, "odds": o} for h, o in
                enumerate([{"1": 0.5, "2": 0.0, "3": 4e-9}, {"1": 0.50004, "2": 0.0, "3": 3e-9}, {"1": 0.7, "2": 0.0, "3": 0.0}])]
        tr = A.trend(rows)
        self.assertEqual(len(tr["t"]), 2)
        self.assertEqual(tr["teams"], {"1": [500, 700], "3": [1, 0]})

    def test_writes_each_published_league_beside_its_data(self):
        site = self.dir / "site"
        write_site(site, {"big12": published("big12"), "sec": published("sec")})
        self.assertEqual(A.write_trends(self.log, site, self.dir / 'none'), ["big12", "sec"])
        tr = json.loads((site / F.LEAGUES["sec"]["path"] / "trend.json").read_text())
        self.assertEqual(len(tr["t"]), 1)
        self.assertEqual(set(tr["teams"]), {t["id"] for t in published("sec")["teams"]})


if __name__ == "__main__":
    unittest.main()
