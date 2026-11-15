#!/usr/bin/env python3
"""Rebuild the title-game odds odds.jsonl missed: from each league's week-start odds to its first
logged row, written to odds-backfill.jsonl for archive.py trend to chart.

  git fetch origin data-history && mkdir -p /tmp/h && git archive FETCH_HEAD | tar -x -C /tmp/h
  python3 tools/odds_backfill.py /tmp/h          # writes odds-backfill.jsonl

odds.jsonl began on 2026-11-15, partway through week 11. What the odds did before then is still in
each league's data.json: the week's starting odds (baseline), and for each game that went final
since, every team it moved by half a point or more, before and after (moved). Starting from the
baseline and applying each game's after-odds in the order the games ended gives the odds after each
result. A team moved less than half a point keeps its last value, and drift between results (pregame
lines changing) is lost; each game's before-odds show how far that went (printed as "mismatch").
ESPN's summary for each game gives when it ended (its "End of Game" play): about one call per game.
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import fetch_data as F  # noqa: E402


def ended_at(gid):
    """When ESPN's play-by-play says game gid ended, or None."""
    s = F.get(f"{F.SITE}/summary?event={gid}")
    drives = s.get("drives") or {}
    plays = [p for dr in drives.get("previous") or [] for p in dr.get("plays") or []]
    end = [p for p in plays if ((p.get("type") or {}).get("text") or "").lower() == "end of game" and p.get("wallclock")]
    return F.parse(end[-1]["wallclock"]) if end else None


def chain(baseline, games, until, ends):
    """The odds after each game in games that ended before until: [(time, odds)], baseline first.
    ends: {game id: when it ended}. Also the worst gap, in points, between a game's before-odds
    and the odds the chain had reached by then."""
    state, rows, worst = dict(baseline["odds"]), [(F.parse(baseline["at"]), dict(baseline["odds"]))], 0.0
    done = sorted((ends[g["id"]], g) for g in games if ends.get(g["id"]) and ends[g["id"]] < until)
    for t, g in (x for x in done if x[1].get("moved")):
        for tid, (before, after) in g["moved"].items():
            worst = max(worst, abs(state.get(tid, 0) - before) * 100)
            state[tid] = after
        rows.append((t, dict(state)))
    return rows, worst


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    history = Path(sys.argv[1])
    logged = {}
    for line in (history / "odds.jsonl").read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            logged.setdefault(r["league"], r)
    out = []
    for lg in F.LEAGUES.values():
        d = json.loads((history / lg["id"] / "data.json").read_text())
        b, first = d.get("baseline"), logged.get(lg["id"])
        if not b or not first or F.parse(b["at"]) >= F.parse(first["at"]):
            continue
        start, until = F.parse(b["at"]), F.parse(first["at"])
        games = [g for g in d["games"] if g["completed"] and g.get("moved") is not None
                 and start <= F.parse(g["date"]) < until]
        ends = dict(F.pmap(lambda g: (g["id"], ended_at(g["id"])), games))
        rows, worst = chain(b, games, until, ends)
        last = max(abs(rows[-1][1].get(t, 0) - p) * 100 for t, p in first["odds"].items())
        print(f"{lg['id']}: {len(rows) - 1} results; mismatch up to {worst:.2f} pts, "
              f"{last:.2f} pts from the first logged row ({first['at']})")
        out += [{"at": F.iso(t), "league": lg["id"], "week": F.current_week(d.get("calendar"), t), "odds": o}
                for t, o in rows]
    (HERE / "odds-backfill.jsonl").write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in out))
    print(f"wrote {len(out)} rows to odds-backfill.jsonl ({F.calls} ESPN calls)")


if __name__ == "__main__":
    main()
