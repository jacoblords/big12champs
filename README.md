# Title Paths

Pick a Big 12, SEC, ACC or Big Ten team and see its likeliest path to the conference championship game:
which results it needs, who to root for, and how the official tiebreakers settle the standings.
The Big 12 page is the site root, the SEC's is `/sec/`, the ACC's `/acc/` and the Big Ten's `/big10/`; the header links them with each
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
  [ACC PDF](https://s3.amazonaws.com/sidearm.sites/acc.sidearmsports.com/documents/2026/7/15/ACC_Football_Tiebreaker_Policy_Jully_2026.pdf),
  [Big Ten](https://bigten.org/sports/2026/11/10/FB_1110261447.aspx)).
  The odds are exact for those inputs, and "clinched", "eliminated", "win out and they're
  in" and "must" are only shown when proven over every finish.
- **Paths:** a team's path is the likeliest set of results that *guarantees* it a title-game
  spot however the other games go, and it shows only those games. The probability of a set is
  the product of ESPN's odds for its results, so every game in the likeliest one is needed.
  `exact.js` finds it from the full enumeration by branch and bound (`guaranteedPath`), inside
  the same time budget. With what-ifs set, or too many games left for exact odds, the page finds
  it from its simulations instead (`guaranteedPathSim` in the engine: the likeliest set that
  rules out every simulated finish where the team misses, re-checked with 20,000 simulations
  with those results forced). Below 0.5% odds the simulations rarely reach a team's winning
  finishes, so the page falls back to the likeliest single finish it found. Tested against
  brute force over every partial set of results, and against the exact answers.
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
- **The Big Ten** (18 teams, nine conference games each) uses its 2024 procedure, the latest
  it has published: the SEC's steps with SportSource's private Team Rating Score (FPI stands
  in), the two teams who get in seeded with the two-team steps, but nobody dropped for losing
  to all the other tied teams and tied opponents in the walk counted together. One rule is its
  own (`cutContinues`): when a step drops some teams from a tie of three or more and three or
  more are still level, they go on to the next step instead of starting over. It reproduces the
  2024 and 2025 title games and all seventeen scenarios the conference published for them.
  With 27 conference games left (Nov. 10, 2026) it is past the exact-odds budget and the page
  simulates; exact odds return once two weeks remain.
- **Gameday:** each league has a gameday page (`/gameday/`, `/sec/gameday/`, …). A Paths |
  Gameday switch in the top bar moves between a league's two views during a regular-season
  week (ESPN's calendar, Monday to Monday), with a live marker on Gameday while one of its
  games is under way; league links keep the view. It is the
  same template with `GAMEDAY` set by `fetch_data.py`, with its own copy of the page data one
  folder down. Two sections:
  - *The race:* every team's title-game odds now, highest first, with the week's starting odds
    and the change. Picking a team reorders the games: its own first, then the games that move
    its odds by a point or more (biggest swing first, its row highlighted, added when below a
    card's top five), then the rest dimmed in kickoff order. The cards slide to their new places
    (not with reduced motion), and on phones the slate scrolls back to its first card. The starting odds are `data.baseline`: the odds
    already published when the fetcher first runs in a new week, kept until the next week.
  - *The games:* kickoff, TV, ESPN's line and venue, and ESPN's win odds, plus how each result
    would move every team's title-game odds (the same exact or simulated splits as the rooting
    guide). The game moving the most is marked "Biggest stakes". Once a game kicks off, its card
    shows ESPN's clock, score and in-game win-probability chart. Links go to ESPN Gamecast,
    r/CFB and X; nothing is embedded. r/CFB's game threads are posted by u/CFB_Referee as
    "[Game Thread] BYU @ Utah (12:00 PM ET)", with full school names where ESPN's short names
    abbreviate, so the link searches that account's posts for "Game Thread" AND the title words
    both names share (dropping "St"/"State"), newest first. Reddit ignores the time limit on such
    a query, so the link shows only from two hours before kickoff, once the newest match is this
    year's thread rather than last year's.

  Nothing on it is live to the second. It updates with the 15-minute fetch on game days.
- **Adding a league:** see [docs/adding-a-league.md](docs/adding-a-league.md): the rules
  research, the tests to write first, and the places a league is wired in.
  `tools/final_fixture.py <league> <season>` builds a finished-season test fixture.
- **Page:** [`app.html`](app.html), a template; `fetch_data.py` inlines the engine. Once every conference game is final it shows
  final standings: each team's seed or "Out" and how the tiebreakers decided it, with no odds,
  paths or rooting guide.

## Data and caching

Visitors never call ESPN. A GitHub Action runs every 15 minutes Thursday through Sunday
(UTC) and every 30 minutes Monday to Wednesday, started by a Cloudflare Worker
([`trigger/`](trigger/README.md)) because GitHub's own schedule fired only every few hours;
an hourly GitHub schedule stays on as a backup. It starts
from the `data.json` currently published on Pages and calls ESPN only for what can have
changed. (`data.json` keeps every logo inlined so the next run has them; the page itself loads
`page-data.json`, the same data with team logos moved to content-named files under `logos/`.)
A game that isn't final yet is simply asked about again on the next run:

| Data | When it is fetched | Calls |
|---|---|---|
| Results | a game is past kickoff + 3h and not final yet (that week's scoreboard) | 1 per week |
| Schedule, TV, lines | weeks with unplayed games, once a day (kickoff times move), and once more when `SCHEDULE_FIELDS` changes | ≤ 3 |
| FPI | every 6 hours, until it has run once after the last regular-season game (then frozen: the tiebreak uses it as of that weekend) | 1 |
| Predictions | when ESPN's FPI run changes, or a game has none yet | 1 per unplayed game |
| Win probability, live score | this week's games from kickoff until ESPN calls them final, every run; a game ESPN calls final has its week's scoreboard read in the same run, so its result lands then instead of at kickoff + 3h | 1 per game under way |
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
- `tests/big10.test.js`: the Big Ten's 2024 and 2025 title games, and each place its
  procedure differs from another league's (its document has no worked examples).
- `tests/big10-scenarios.test.js`: the Big Ten's own scenarios before the last two weeks of 2024
  (ten) and the last week of 2025 (seven), over every finish; two 2024 scenarios pin the
  finishes where step 4 is an exact tie, which the sheet didn't consider.
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
python3 fetch_data.py --league big10 --site site  # Big Ten; ./data-big10.json, site/big10/
python3 -m http.server -d site                  # then open http://localhost:8000
```

`fetch_data.py` also writes `<league>-path.html`, a single self-contained page with the data
embedded. Set `SEASON` (or `--season`) for another year. The deploy workflow runs one step per
league; each writes its page every run, so a deploy for one league's change carries all four.
