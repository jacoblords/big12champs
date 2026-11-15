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


if __name__ == "__main__":
    unittest.main()
