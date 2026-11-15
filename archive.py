#!/usr/bin/env python3
"""The published data's history, kept on the data-history branch (update.yml's archive job).

The published data.json files are the only copy of what can't be fetched again: each finished
game's moved odds and last line, the week's starting odds, FPI as of each run. A deploy that
breaks them overwrites the only copy, and the Pages artifacts holding earlier ones expire. So
after every deploy the archive job commits each league's data.json to data-history, and this
script is what it runs:

  record SITE HISTORY    copy each league's SITE/<path>/data.json to HISTORY/<league>/data.json,
                         one key per line so git diffs and deltas stay small, with every inlined
                         PNG (most of the file) moved to HISTORY/logos/<hash>.png; and append
                         each league's title-game odds to HISTORY/odds.jsonl when they changed
  trend ODDS SITE        write each league's SITE/<path>/trend.json for the page's odds chart:
                         odds-backfill.jsonl (what odds.jsonl began too late for), ODDS
                         (data-history's odds.jsonl), and the odds SITE is about to publish
  restore HISTORY OUT    the reverse: OUT/<path>/data.json as published, logos inlined again,
                         for update.yml's "restore" input to start every league from (all
                         of them must be there)

odds.jsonl, one line per league per change, is the season's trend:
  {"at": "2026-11-15T03:16Z", "league": "big12", "week": 12, "odds": {"<team id>": 0.4127, ...}}
"""
import argparse, base64, hashlib, json, re
from pathlib import Path

import fetch_data as F

PNG = "data:image/png;base64,"
LOGO = re.compile(r"logos/[0-9a-f]{16}\.png")
# odds.jsonl's rows from before it began, rebuilt by tools/odds_backfill.py
BACKFILL = Path(__file__).resolve().parent / "odds-backfill.jsonl"


def _walk(x, fn):
    if isinstance(x, dict):
        return {k: _walk(v, fn) for k, v in x.items()}
    if isinstance(x, list):
        return [_walk(v, fn) for v in x]
    return fn(x)


def slim(data, history):
    """data with every inlined PNG written to history/logos/ and referenced by that path."""
    out = history / "logos"

    def to_file(v):
        if not isinstance(v, str) or not v.startswith(PNG):
            return v
        png = base64.b64decode(v[len(PNG):])
        name = f"logos/{hashlib.sha256(png).hexdigest()[:16]}.png"
        if not (history / name).exists():
            out.mkdir(parents=True, exist_ok=True)
            (history / name).write_bytes(png)
        return name
    return _walk(data, to_file)


def unslim(data, history):
    """slim's reverse: each logos/<hash>.png path inlined again from history."""
    return _walk(data, lambda v: F.png_uri((history / v).read_bytes())
                 if isinstance(v, str) and LOGO.fullmatch(v) else v)


def odds_row(data):
    """A data file's odds.jsonl line, or None when it has no odds."""
    odds = F.odds_snapshot(data)
    if not odds:
        return None
    at = (data.get("meta") or {}).get("updatedAt") or data.get("fetchedAt")
    t = F.parse(at)
    week = F.current_week(data.get("calendar"), t) if t else None
    return {"at": at, "league": data.get("league", "big12"), "week": week, "odds": odds}


def last_odds(log):
    """{league: its last recorded odds} from odds.jsonl."""
    last = {}
    if log.exists():
        for line in log.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                last[r["league"]] = r["odds"]
    return last


def record(site, history):
    """Copy every league's published data into history; returns the leagues whose data changed."""
    history.mkdir(parents=True, exist_ok=True)
    log = history / "odds.jsonl"
    last = last_odds(log)
    changed, rows = [], []
    for lg in F.LEAGUES.values():
        src = site / lg["path"] / "data.json"
        if not src.exists():
            continue
        data = json.loads(src.read_text())
        text = json.dumps(slim(data, history), indent=1) + "\n"
        dst = history / lg["id"] / "data.json"
        if not dst.exists() or dst.read_text() != text:
            dst.parent.mkdir(exist_ok=True)
            dst.write_text(text)
            changed.append(lg["id"])
        row = odds_row(data)
        if row and row["odds"] != last.get(lg["id"]):
            rows.append(row)
    if rows:
        with log.open("a") as f:
            for r in rows:
                f.write(json.dumps(r, separators=(",", ":")) + "\n")
    return changed


def read_rows(path, league):
    if not path.exists():
        return []
    return sorted((r for r in map(json.loads, filter(str.strip, path.read_text().splitlines())) if r["league"] == league),
                  key=lambda r: F.parse(r["at"]))


def trend_rows(log, data, backfill=BACKFILL):
    """One league's odds over the season, oldest first: backfill's rows from before log's first,
    the week's starting odds data.json keeps when they're older still (with what happened between
    them and the next row unrecorded), log's rows for that league, then data's own odds when they
    aren't the last row's yet (the update job runs before archive has recorded them)."""
    league = data.get("league", "big12")
    rows = read_rows(log, league)
    rows = [r for r in read_rows(backfill, league) if not rows or F.parse(r["at"]) < F.parse(rows[0]["at"])] + rows
    b = data.get("baseline") or {}
    if b.get("odds") and b.get("at") and (not rows or F.parse(b["at"]) < F.parse(rows[0]["at"])):
        # what changed between them went unrecorded (odds.jsonl began on 2026-11-15)
        rows.insert(0, {"at": b["at"], "odds": b["odds"], "gap": bool(rows)})
    now = odds_row(data)
    if now and (not rows or rows[-1]["odds"] != now["odds"]) and (not rows or F.parse(now["at"]) >= F.parse(rows[-1]["at"])):
        rows.append(now)
    return rows


def tenths(p):
    """Odds in tenths of a point; a team that isn't out keeps at least 1, so it never reads as out."""
    return 0 if not p else max(1, round(p * 1000))


def trend(rows):
    """rows as trend.json, columns kept small: t in minutes since the epoch, each team's odds in
    tenths of a point at each t, and gaps, each k where what happened between t[k] and t[k+1]
    went unrecorded. A row the same as the one before once rounded is dropped, and so is a team
    at 0 throughout."""
    ids = sorted({tid for r in rows for tid in r["odds"]}, key=lambda x: (len(x), x))
    t, cols, gaps = [], {tid: [] for tid in ids}, []
    last = None
    for r in rows:
        v = [tenths(r["odds"].get(tid)) for tid in ids]
        if v == last:
            continue
        last = v
        if r.get("gap"):
            gaps.append(len(t))
        t.append(int(F.parse(r["at"]).timestamp() // 60))
        for tid, x in zip(ids, v):
            cols[tid].append(x)
    return {"t": t, "teams": {tid: c for tid, c in cols.items() if any(c)},
            "gaps": [k for k in gaps if k + 1 < len(t)]}


def write_trends(log, site, backfill=BACKFILL):
    """Each published league's site/<path>/trend.json; returns the leagues written."""
    done = []
    for lg in F.LEAGUES.values():
        src = site / lg["path"] / "data.json"
        if src.exists():
            data = json.loads(src.read_text())
            (src.parent / "trend.json").write_text(json.dumps(trend(trend_rows(log, data, backfill)), separators=(",", ":")))
            done.append(lg["id"])
    return done


def restore(history, out):
    """Write each recorded league's data.json, as published, to out/<league path>/data.json."""
    missing = [l for l in F.LEAGUES if not (history / l / "data.json").exists()]
    if missing:  # the workflow would start those leagues from nothing
        raise SystemExit(f"no {', '.join(missing)} data under {history}")
    done = []
    for lg in F.LEAGUES.values():
        src = history / lg["id"] / "data.json"
        dst = out / lg["path"] / "data.json"
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(json.dumps(unslim(json.loads(src.read_text()), history), separators=(",", ":")))
        done.append(lg["id"])
    return done


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record"); r.add_argument("site", type=Path); r.add_argument("history", type=Path)
    s = sub.add_parser("restore"); s.add_argument("history", type=Path); s.add_argument("out", type=Path)
    t = sub.add_parser("trend"); t.add_argument("odds", type=Path); t.add_argument("site", type=Path)
    a = ap.parse_args(argv)
    if a.cmd == "record":
        changed = record(a.site, a.history)
        print(f"Recorded {', '.join(changed) or 'nothing new'}")
    elif a.cmd == "trend":
        print(f"wrote trend.json for {', '.join(write_trends(a.odds, a.site)) or 'no league'}")
    else:
        done = restore(a.history, a.out)
        print(f"restored {', '.join(done)} to {a.out}")


if __name__ == "__main__":
    main()
