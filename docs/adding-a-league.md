# Adding a league

How the SEC, the ACC, the Big Ten and the Pac-12 were added, written down so the next league goes faster. The order
matters: **rules first, then tests, then code.** Tiebreak procedures are long, and summaries of
them are often wrong. The SEC was first built from press summaries and got three rules wrong;
the official document caught all three. The ACC rewrote its procedure for 2026, so the seasons
in its tests ran under different rules from the live page.

A league touches these places, and nothing else:

| Where | What |
|---|---|
| `fetch_data.py` → `LEAGUES` | id, name, URL path, ESPN group id, optional title sponsor, optional `lastConfWeek` |
| `engine.js` → `RULES` | which tiebreak steps it uses, its step labels, and rule switches |
| `app.html` → `LEAGUE_TEXT` | the rulebook in plain words, the gray areas, and the policy link |
| `.github/workflows/update.yml` | one fetch step per league |
| `.github/workflows/ci.yml` | one offline build per league, from a season snapshot |
| `tests/` | final-season fixtures, `<league>.test.js`, `<league>-scenarios.test.js` |

## 1. Find the rules: the official document, not a summary

- Find the conference's own tiebreaker procedure. Note its title and version date in the test
  file header. The policy link goes in `LEAGUE_TEXT`.
- Conference sites often render the page with JavaScript, so a fetch shows nothing. The
  Wayback Machine helps:
  - list snapshots with
    `https://web.archive.org/cdx/search/cdx?url=<page>&output=json&collapse=digest`;
  - fetch the raw page as `https://web.archive.org/web/<timestamp>id_/<page>` (use
    `curl --compressed`);
  - search the embedded page data for `.pdf`. The SEC's procedure PDF was only linked from
    inside that data.
- Check the latest snapshot links the same version. Rules change, often with schedule changes.
  A file can change under the same URL: the ACC's `2023/5/17/ACC_FOOTBALL_TIEBREAKER_POLICY.pdf`
  held one version in 2023, another from Aug. 2024 and a third from Sept. 2025. Compare Wayback
  snapshots of the PDF itself, and `pdfinfo` creation dates.
- **Hosts die.** The Big Ten's 2024 PDF lived on a Contentstack asset URL, then a bigten.org
  `api/media/file/` URL; both stopped working when the conference moved to Sidearm in 2026.
  List every copy with a CDX prefix search (`url=<host>/<path prefix>&matchType=prefix`, grep for
  "tiebreak"); a matching `digest` across hosts and years proves it's the same file, which is how
  "unchanged through 2025" was established. Link the Wayback copy from the page when the
  original is gone.
- A file called "Tiebreakers" may be for other sports: the Big Ten's `2026_Tiebreakers.pdf` is
  its Olympic-sports procedure. Check the title before reading further.
- Sidearm-hosted conference sites (theacc.com, bigten.org since 2026) serve their documents from
  `s3.amazonaws.com/sidearm.sites/<site>/documents/...`; a search for the document title often
  finds that URL directly.
- **If the procedure changed, find the old one too.** The real title games and published
  scenarios in your tests ran under it. Put it in `RULES.<league>.before: { season, rules }`,
  so `rulesFor(league, season)` picks the rules by the data's season.
- Read all of it, especially the worked examples. Every example becomes a test.
- No worked examples in the document? Look for the conference explaining it to reporters. The
  ACC's 2026 policy has none, but its vice president of football walked On3 through two, which
  settled what "working downward" means. Sites that refuse a fetch (403) often have a Wayback copy.

## 2. Compare it with the engine, rule by rule

The engine has one set of steps, a to g, named by their Big 12 letters:

- a: head-to-head
- b: common opponents
- c: walk the standings
- d: opponents' winning percentage
- e: total wins
- f: rating
- g: coin toss or random draw

Each league lists the steps it uses in `RULES`, in order, with its own labels.

Go through these questions; they are where the Big 12 and the SEC differ:

| Question | Switch in `RULES` | Big 12 | SEC | ACC 2024-25 | ACC 2026- |
|---|---|---|---|---|---|
| Which steps, in what order, called what? | `steps`, `label` | a-g, lettered | no e; numbered 1-6 | no e; lettered a-f | a, f, g only; numbered 1-3 |
| Do non-conference games count anywhere (e.g. total wins)? | follows from step e | yes | no, so they aren't enumerated | no | no |
| No round robin: is a team that lost to all the others out? | `h2hLoserOut` | no | yes | yes | yes |
| Standings walk: tied opponents counted together, or split by head-to-head first? | `walkSplitsTies` | together | split first | split first (stands in for "with ties broken") | no walk |
| What does the rating step compare? | `rating` (`"fpi"` or `"margin"`) | private SportSource rating, so FPI stands in | published scoring-margin formula | private, FPI | private, FPI |
| A tie of 3+ for first: are the two who get in re-seeded with the two-team steps? | `reseedTop2` | no | yes | no | no |
| Do teams play different numbers of conference games, with "tied" redefined for it? | `redefine` | no | no | no | yes |
| Did the procedure change between seasons? | `before` | no | no | | 2024-25 rules kept |
| After a cut, do three or more still level go on to the next step (not back to a)? | `cutContinues` | no | no | no | n/a |
| Not all tied teams played: is a team that beat all the others still pulled out at step a? | `h2hAllPlayedOnly` (off = yes) | yes | yes | yes | yes |

The Big Ten (2024 procedure, still in force in 2026) answers: steps a-d, f, g numbered 1-6;
no non-conference games; `h2hLoserOut` no; `walkSplitsTies` no ("order of finish", nothing
about ties); `rating` FPI for the private SportSource score; `reseedTop2` yes (its own 2024
scenarios seed Oregon over Ohio State after Ohio State got in first); `redefine` no (everyone
plays nine); `cutContinues` yes, its one new rule.

`redefine` replaces the title-game driver (`titleGameRedefine` in `engine.js`): the tie is
defined from the best winning percentage plus teams on the other schedule length with the same
wins or the same losses; a two-team tie's winner is only in once nobody is tied with it; and
every restart defines the tie again. Where a rating step decides almost everything (the ACC's
2026 rules), say so plainly on the page: FPI is a stand-in, and those finishes can go the other
way.

Also check these. Every league so far agrees with the engine on them, with the one exception
noted:

- A team alone at the top of a step is in, and the rest start over.
- If several teams are level at the top and some are below, the ones below are out and the
  rest start over (the Big Ten: only when two are left; three or more go on to the next step,
  `cutContinues`).
- A team that beat every other tied team is in.
- Common opponents leave the tied teams themselves out.
- In the walk, only opponents every tied team played are counted.
- The title game doesn't count in records.

If the new league does something none of these switches covers, add a switch to `RULES`,
default it off for the existing leagues, and write its test first. Keep step ids stable: traces,
tests and the page all use them.

## 3. Tests first

**Fixtures.** Build each finished season from ESPN:

```bash
python3 tools/final_fixture.py acc 2025   # → tests/fixtures/final-acc-2025.json
```

The league has to be in `LEAGUES` first; that one line is enough. The script prints conference
games per team, so you can check the schedule length (8, 9, or a mix).

**`tests/<league>.test.js`** (see `tests/sec.test.js`):

- **Real title games.** The final standings must reproduce the actual matchup and seeding. On
  ESPN, the title game's home team is the #1 seed: check the week-15 scoreboard with
  `groups=<id>`. Keep the explanation as a comment. The 2025 SEC game (Alabama hosting Georgia)
  is what revealed `reseedTop2`.
- **Every worked example** in the official document, as a hand-built table using
  `standingsTable` and `seeds` from `tests/helpers.js`. Examples state only the deciding fact.
  Add opponents so that the earlier steps come out even. Give later steps a rating so they don't
  fall through to a random draw.
- **The rule switches.** For each switch that differs from the Big 12, show the same table giving
  a different result in each league.

**`tests/<league>-scenarios.test.js`** (see `tests/sec-scenarios.test.js`, and
`tests/scenarios.test.js` for the Big 12's official ones):

- Use the conference's own published scenarios if it has them. The Big 12 publishes them; the
  SEC doesn't; the ACC did once (2025's final week). To find them, list the conference's news
  URLs for November in the Wayback CDX (`url=<site>/news/<year>/1&matchType=prefix`) and grep
  for "tiebreak". Otherwise use press articles from the last two or three weeks of a season, with
  claims stated outright ("if X wins, X is in").
- Record the date, the outlet, and which games had been played when each article was written.
- `replayFinal(file, weeks)` un-plays those weeks and gives every finish. `check` and `checkIn`
  assert a claim over every finish it covers.
- **When a claim fails, trace it before changing anything.** `B.explain(ctx, finish.mask)` shows
  every tiebreak step. In the SEC's case, every failure was something the article overlooked:
  - an upset by a winless team,
  - an exact tie settled two steps later,
  - a head-to-head result.

  Pin each exception with the step that decides it, so it stays documented. Change the engine
  only if the official text says it's wrong.
- A combination that ends "finish higher than X in the SportSource ranking" can't be checked
  against FPI. Check instead that the rating step decides it, between the teams named.
- When scraping an article's lists, don't drop repeated lines: the same bullet ("Virginia beats
  Virginia Tech") can belong to two teams' lists, and losing one makes a claim look wrong.

Run `node --test tests/*.test.js` and `python3 -m unittest discover -s tests`.

## 4. Wire it in

1. **`LEAGUES`** in `fetch_data.py`: `{"id", "name", "path": "<id>/", "group"}`. The nav lists
   leagues in this order. The fetcher skips the title game using ESPN's game type or a note
   containing `"<name> Championship"`. Check that the title game really is excluded: in 2025,
   ESPN didn't mark the SEC game as a conference championship, and only the note caught it.
   (The ACC's reads "ACC Championship"; the fixture script's per-team count shows it: 8-8.)
2. **`RULES`** in `engine.js`, from step 2.
3. **`LEAGUE_TEXT`** in `app.html`:
   - `steps`: overrides of the shared step text, only where the league's wording differs.
   - `stepOn` and `col`: wording for the tiebreak sentences and tables.
   - `h2h`, `threeWay`, `titleGame`: the corner cases. Optional `tied` and `ladder` add corner
     cases first and after the tie-for-second line (the ACC uses both).
   - `gray`: every judgment call the site makes, plus what the engine reproduces.
   - `policy`: the official document's link.
4. **`update.yml`**: add a step like the SEC's, with its own `--prev "$PUBLISHED/<id>/data.json"`.
   Add it to the `changed` output and to the upload condition too.
5. **`ci.yml`**: add an offline build from a season snapshot
   (`tests/fixtures/<id>-season-<date>.json`: fetch the current season with `fetch_data.py`, and
   drop `exact` and the logos). Add the folder to the "Built pages parse" check.
6. **Page tests** (`tests/page.test.js`): the league renders with its own name, steps, policy link
   and no other league's text. Add the league to the `LEAGUES` list in the header tests.
7. **README**: list the league, and add its test files to "Tests and CI".

## 5. Check it

- **Exact odds:** each unplayed game the tiebreakers can see doubles the work. Count the
  conference games left in the last three weeks: about 24 or fewer runs in under a minute (the
  ACC on 2026-11-09: 22 games, 4.2 million finishes, 15 seconds).
  Leagues without a total-wins step skip non-conference games. Larger counts fall back to
  simulation, with no change needed.
- **Look at it:**

  ```bash
  python3 fetch_data.py --league <id> --data-out /tmp/<id>.json --site /tmp/site
  ```

  Then serve `/tmp/site`. Check both themes and a phone-width window. Open a few teams whose
  paths need a tiebreak and read the sentences.
- **Tied teams with different records:** under `redefine`, a tie can be 7-2 and 6-2. The page
  names each record and says what they share; check a path that shows one.
- **Port in use:** another session may hold the usual preview port. Pick another; don't stop
  a server you didn't start.
- **CSS:** `app.html` is one stylesheet. New class names can collide with existing ones. The
  header's `.bar` once took on the rooting guide's 6px progress bar.
- **Audit with fresh eyes.** Before calling a league done, have someone who didn't build it read
  the official text clause by clause against the engine, without seeing your conclusions. For
  each reading they disagree with, they should construct a standings table that comes out
  differently, and measure how often it happens in the live snapshot. The November 2026 audit of
  the ACC found the policy's "working downward" applied only to two-team ties, a 3-point swing in
  live odds. All 25 ACC tests passed either way, because no test had a mixed-record tie of three.
  A second search for press scenarios also found claims the new rule then satisfied.
- **Sampled checks for the live season:** `sampleSeason(file, n)` in `tests/helpers.js` draws
  random finishes when too many games are left to try them all. Use it for in-season press
  claims (`tests/acc-scenarios.test.js` has two).

## What the Big Ten taught

- **Read the restart rule word by word.** Every league so far said "the remaining teams revert
  to the beginning" once a team is seeded. The Big Ten also says what happens after a step drops
  *some* teams: "If three or more teams remain tied after any step, move to next step". That is
  `cutContinues`. No published scenario exercises it, so its test is a hand-built table.
- **A conference's own scenarios can still miss exact ties.** The Big Ten's 2024 sheet says
  "seeded on opponents' winning percentage" for finishes where two teams end at exactly the same
  x/81; then the rating decides. 104 of the finishes the sheet covers are like that, pinned in
  `big10-scenarios.test.js`. Compare step-d values as fractions (the engine does), never as
  rounded decimals.
- **Scenario sheets describe finishes, not games.** "Ohio State finishes 7-2 (losses to ORE and
  MICH)" pins Ohio State's remaining games; "Penn State finishes 7-2 (losses to OSU and either
  MINN/MD)" means exactly one of two games, an XOR. Translate each into results on the pending
  games and leave everything else free.
- **18 teams, nine games each: exact odds wait for the last two weeks.** On 2026-11-10, 27
  conference games were left: 134 million finishes, estimated at 442 s against the 180 s budget,
  so the page simulated. With 18 left it takes under a second. CI builds the 27-game snapshot
  under the production budget and checks that it falls back to simulation.
- **Five leagues in the header** need a tighter gap below 440 px and smaller type below 360 px to
  stay on one line at 320 px. A sixth will need another look.
- The conference's site is its own best source for scenarios: it published them for the last two
  weeks of 2024 (a PDF) and the last week of 2025 (an article), each with the deciding steps.

## What the ACC taught

- The rules changed for the season being shown, so the tests carry both versions (`before`).
  2024 and 2025 reproduce the real title games only under the old rules. The 2025 tie also runs
  under the new ones, and FPI picks Miami, which is what coverage of the new policy said.
- Only the conference can tell you what an ambiguous clause means. "Starting with the highest
  win percentage, working downward" read three ways until the ACC's own examples settled it.
- 17 teams and mixed schedule lengths: check the conference-games-per-team line from
  `final_fixture.py`, and games per team in the live data (2026: five teams at 8, twelve at 9).
- Notre Dame plays a partial ACC schedule but isn't in ESPN's group 1 standings, so its games
  count as non-conference, which matches the ACC's standings.

## What the Pac-12 taught

- **A new league has no history to replay.** The rebuilt Pac-12's first season is 2026, so there
  are no title games to reproduce. The tests lean on the procedure's clauses, real finishes from
  the live snapshot where the walk or the rating decides, and reporters' scenarios over every
  finish. ESPN's group 9 standings hold only the eight current members.
- **Not every conference game counts.** ESPN flags the week-13 "flex" games as conference games
  (with TBD opponents until the pairings are set), but the Pac-12 leaves them out of the
  standings. `lastConfWeek` in `LEAGUES` cuts them off by ESPN's week number.
- **Procedures can be published as a section of a press release**, not a PDF: the Pac-12's is in its
  Sept. 3, 2026 operational-updates release. Read the raw HTML: the two-team list's first `<li>`
  is the "tied for first" sentence, so head-to-head isn't one of the numbered steps for a tie for
  second. Work out what each reading does before choosing: in a round robin, the listed steps would
  rank the loser of the tied teams' game first, which is why the site (and every reporter) keeps
  head-to-head.
- **The conference's own scenarios can settle gaps in its text.** Its weekly release ("This Week in
  Pac-12 Football", "Chase for the Champ Game") states who clinches and who is out. Run each
  reading of an unclear clause against those statements: head-to-head for a tie for second, and
  dropping the teams below a level top, were each the only readings under which every statement
  held. An independent audit (November 2026) found the canceled-game rule wrong: the Pac-12 skips
  head-to-head entirely when not all tied teams met (`h2hAllPlayedOnly`).
- **A round robin makes steps redundant.** With everyone playing everyone, common opponents and
  strength of schedule can't split a tie that head-to-head didn't. A test enumerates every finish
  and checks that only head-to-head, the walk and the rating ever decide.
