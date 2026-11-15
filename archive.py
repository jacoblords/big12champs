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
    a = ap.parse_args(argv)
    if a.cmd == "record":
        changed = record(a.site, a.history)
        print(f"Recorded {', '.join(changed) or 'nothing new'}")
    else:
        done = restore(a.history, a.out)
        print(f"restored {', '.join(done)} to {a.out}")


if __name__ == "__main__":
    main()
