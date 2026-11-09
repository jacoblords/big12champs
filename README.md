# Big 12 Title Paths

Pick a Big 12 team and see its likeliest path to the conference championship game: which
results it needs, who to root for, and how the official tiebreakers settle the standings.

- **Odds:** each remaining game is simulated 40,000 times using ESPN's Matchup Predictor win
  probabilities, and every simulated finish is sorted by the Big 12's tiebreaking procedures
  ([official PDF](https://s3.amazonaws.com/big12sports.com/documents/2025/11/4/Big_12_Football_2024_Tiebreaker_Policy.pdf)).
- **Engine:** [`engine.js`](engine.js). Run against final results it reproduces 2024
  (ASU, then Iowa State out of a four-way tie via strength of schedule) and 2025.
- **Page:** [`app.html`](app.html), a template; `fetch_data.py` inlines the engine.

## Data and caching

Visitors never call ESPN. A GitHub Action runs every 30 minutes, starts from the
`data.json` currently published on Pages, and calls ESPN only for what can have changed:

| Data | When it is fetched | Calls |
|---|---|---|
| Results | a game is past kickoff + 3h and not final yet (that week's scoreboard) | 1 per week |
| Schedule | weeks with unplayed games, once a day (kickoff times move) | ≤ 3 |
| FPI | every 6 hours | 1 |
| Predictions | when ESPN's FPI run changes, or a game has none yet | 1 per unplayed game |
| Teams, logos, calendar | once | ~34 |

A cold start is about 75 calls. Most scheduled runs make none and deploy nothing.
Requests run at most 4 at a time and back off on 429/5xx. ESPN's API is undocumented and
public; it publishes no rate limits and sends `Cache-Control: max-age=1`, so caching is ours.

## Local use

```bash
python3 fetch_data.py --site site   # incremental; reuses ./data.json
python3 -m http.server -d site      # then open http://localhost:8000
```

`fetch_data.py` also writes `big12-path.html`, a single self-contained page with the data
embedded. Set `SEASON` (or `--season`) for another year.
