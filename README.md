# Title Paths

Pick a Big 12, SEC or ACC team and see its likeliest path to the conference championship game:
which results it needs, who to root for, and how the official tiebreakers settle the standings.
The Big 12 page is the site root, the SEC's is `/sec/` and the ACC's `/acc/`; the header links them with each
conference's ESPN logo, and Monster Energy's claw in front of the Big 12 (its title sponsor
since July 2026; [`monster-claw.png`](monster-claw.png) is cropped from the public-domain logo on Wikimedia Commons).

Live at **https://titlepaths.com** (GitHub Pages with a custom domain; the old
`jacoblords.github.io/big12champs` address redirects there). DNS is four A records for the
bare domain pointing at GitHub Pages (185.199.108-111.153) and a `www` CNAME to
`jacoblords.github.io`.

- **Odds:** [`exact.js`](exact.js) enumerates every possible finish of the remaining games
  (2^24 = 16.8 million with three weeks left, about 40 seconds), weights each by ESPN's
  Matchup Predictor win probabilities, and sorts each by the league's tiebreaking procedures
  ([Big 12 PDF](https://s3.amazonaws.com/big12sports.com/documents/2025/11/4/Big_12_Football_2024_Tiebreaker_Policy.pdf),
  [SEC](https://www.secsports.com/news/2024/08/sec-announces-football-tie-breaking-process),
  [ACC PDF](https://s3.amazonaws.com/sidearm.sites/acc.sidearmsports.com/documents/2026/7/15/ACC_Football_Tiebreaker_Policy_Jully_2026.pdf)).
  The odds are exact for those inputs, and "clinched", "eliminated", "win out and they're
  in" and "must" are only shown when proven over every finish.
- **Time budget:** each extra unplayed game doubles the work, so `exact.js` times a sample
  of finishes first and skips if the whole run would take more than 80% of
  `EXACT_BUDGET_SECONDS` (180 in the workflow); a run that still overruns stops at the
  budget. Skipped runs fall back to a 40,000-run simulation and the page footer says why.
  In practice that means about 25 or fewer games left (the last three weeks) get exact
  odds and the rest of the season gets simulation, with no change needed between seasons.
  The page's what-ifs always use simulation.
- **Limits:** the odds are only as good as ESPN's predictions, and games are treated as
  independent. Adding correlated team strength moved the 2026-11-09 odds by about a point at
  most.
- **Engine:** [`engine.js`](engine.js). One set of steps; `RULES` says which each league
  uses and how it names them. Where the SEC's
  [official procedure](https://storage.googleapis.com/secsports-prod/upload/2024/10/29/f6fc7cd9-3031-4357-8754-80bfa4b9c4c0.pdf)
  differs from the Big 12's: no total-wins step (so non-conference games are left out
  entirely); with no round robin, a team that lost to every other tied team is eliminated; in
  the standings walk, a tied group of opponents is ordered by head-to-head before being combined;
  step 5 is a capped relative scoring margin computed from real scores; and after a tie of three
  or more for first, the two teams that got in are seeded with the two-team steps. Run against final results it reproduces the Big 12's 2024 (ASU, then
  Iowa State out of a four-way tie via strength of schedule) and 2025, and the SEC's 2024 and
  2025 (Alabama and Georgia out of a four-way tie at 7-1, Alabama #1 on head-to-head).
- **The ACC** rewrote its procedure for 2026, so `RULES.acc.before` keeps the 2024-25 one
  (the SEC's switches, SportSource rating, no re-seeding) and the season picks. The
  [2026 policy](https://s3.amazonaws.com/sidearm.sites/acc.sidearmsports.com/documents/2026/7/15/ACC_Football_Tiebreaker_Policy_Jully_2026.pdf)
  has three steps: head-to-head, SportSource's private Team Success Ranking (FPI stands in, and
  it decides most ties), and a draw. Teams play eight or nine conference games, so a team with
  the same wins or the same losses as the leaders on a different schedule length counts as
  tied, and ties are worked "downward" (the `redefine` switch, following the ACC's own
  examples as given to On3). It reproduces the 2024 and 2025 title games under the old rules.
- **Adding a league:** see [docs/adding-a-league.md](docs/adding-a-league.md): the rules
  research, the tests to write first, and the places a league is wired in.
  `tools/final_fixture.py <league> <season>` builds a finished-season test fixture.
- **Page:** [`app.html`](app.html), a template; `fetch_data.py` inlines the engine.

## Data and caching

Visitors never call ESPN. A GitHub Action runs every 15 minutes Thursday through Sunday
(UTC) and every 30 minutes Monday to Wednesday, at minutes offset from the hour. It starts
from the `data.json` currently published on Pages and calls ESPN only for what can have
changed. A game that isn't final yet is simply asked about again on the next run:

| Data | When it is fetched | Calls |
|---|---|---|
| Results | a game is past kickoff + 3h and not final yet (that week's scoreboard) | 1 per week |
| Schedule | weeks with unplayed games, once a day (kickoff times move) | ≤ 3 |
| FPI | every 6 hours | 1 |
| Predictions | when ESPN's FPI run changes, or a game has none yet | 1 per unplayed game |
| Teams, logos, calendar | once | ~34 |

A cold start is about 75 calls. Most scheduled runs make none and deploy nothing. On a
game day it's about one scoreboard call per run while games are finishing, and at most
four Pages deploys an hour, well under GitHub's soft limit of 10. Public repos have
unlimited Actions minutes.
Requests run at most 4 at a time and back off on 429/5xx. ESPN's API is undocumented and
public; it publishes no rate limits and sends `Cache-Control: max-age=1`, so caching is ours.

## Tests and CI

```bash
node --test tests/*.test.js                 # engine rules, exact solver, page rendering
python3 -m unittest discover -s tests       # fetcher caching rules against a fake ESPN
```

- `tests/sec.test.js`: the SEC's 2024 and 2025 title games, published final-week scenarios,
  and the worked examples in the SEC's official procedure.
- `tests/sec-scenarios.test.js`: SEC scenarios from CBS, SDS and FanSided in November 2024 and
  2025, replayed over every finish. Where an article overlooked a combination, the exception is
  pinned with the step that decides it.
- `tests/acc.test.js`: the ACC's 2024 and 2025 title games, the 2026 procedure (the ACC's own
  worked examples, given to On3, and every clause of the policy), and where it differs from
  the Big 12 and SEC.
- `tests/acc-scenarios.test.js`: the ACC's own 2025 final-week scenarios (every combination,
  including those that hinge on the SportSource ranking) and press scenarios from November
  2024 and 2025, replayed over every finish, with two SI paths that miss a step pinned.
- `tests/engine.test.js`: 2024 and 2025 final standings reproduce the real title games, plus a
  hand-built standings table for each rule and corner case (sweep rule, restart after a
  seed, standings walk with tied groups, steps d to g, FCS cap, canceled games).
- `tests/exact.test.js`: odds sum correctly, splits are consistent, the best path is the
  true maximum by brute force, and results agree with an independent simulation.
- `tests/page.test.js`: renders every team from `app.html` against a stub DOM, including
  what-ifs, the simulation fallback and escaping of ESPN-supplied text.
- `tests/test_fetch.py`: which ESPN calls happen when, using a fake ESPN.

`.github/workflows/ci.yml` runs all of this on every pull request, then builds the site
offline from each league's season snapshot and checks it.

## Local use

```bash
python3 fetch_data.py --site site               # Big 12; incremental, reuses ./data.json
python3 fetch_data.py --league sec --site site  # SEC; reuses ./data-sec.json, writes site/sec/
python3 fetch_data.py --league acc --site site  # ACC; reuses ./data-acc.json, writes site/acc/
python3 -m http.server -d site                  # then open http://localhost:8000
```

`fetch_data.py` also writes `<league>-path.html`, a single self-contained page with the data
embedded. Set `SEASON` (or `--season`) for another year. The deploy workflow runs one step per
league; each writes its page every run, so a deploy for one league's change carries all three.
