# Adding a league

How the SEC was added, written down so the next league (the ACC) goes faster. The order
matters: **rules first, then tests, then code.** Tiebreak procedures are long, and summaries of
them are often wrong. The SEC was first built from press summaries and got three rules wrong;
the official document caught all three.

A league touches these places, and nothing else:

| Where | What |
|---|---|
| `fetch_data.py` → `LEAGUES` | id, name, URL path, ESPN group id, optional title sponsor |
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
- Read all of it, especially the worked examples. Every example becomes a test.

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

| Question | Switch in `RULES` | Big 12 | SEC |
|---|---|---|---|
| Which steps, in what order, called what? | `steps`, `label` | a-g, lettered | no e; numbered 1-6 |
| Do non-conference games count anywhere (e.g. total wins)? | follows from step e | yes | no, so they aren't enumerated |
| No round robin: is a team that lost to all the others out? | `h2hLoserOut` | no | yes |
| Standings walk: tied opponents counted together, or split by head-to-head first? | `walkSplitsTies` | together | split first |
| What does the rating step compare? | `rating` (`"fpi"` or `"margin"`) | private SportSource rating, so FPI stands in | published scoring-margin formula |
| A tie of 3+ for first: are the two who get in re-seeded with the two-team steps? | `reseedTop2` | no | yes |

Also check these. Both leagues so far agree with the engine on them:

- A team alone at the top of a step is in, and the rest start over.
- If several teams are level at the top and some are below, the ones below are out and the
  rest start over.
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
  SEC doesn't. Otherwise use press articles from the last two or three weeks of a season, with
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

Run `node --test tests/*.test.js` and `python3 -m unittest discover -s tests`.

## 4. Wire it in

1. **`LEAGUES`** in `fetch_data.py`: `{"id", "name", "path": "<id>/", "group"}`. The nav lists
   leagues in this order. The fetcher skips the title game using ESPN's game type or a note
   containing `"<name> Championship"`. Check that the title game really is excluded: in 2025,
   ESPN didn't mark the SEC game as a conference championship, and only the note caught it.
2. **`RULES`** in `engine.js`, from step 2.
3. **`LEAGUE_TEXT`** in `app.html`:
   - `steps`: overrides of the shared step text, only where the league's wording differs.
   - `stepOn` and `col`: wording for the tiebreak sentences and tables.
   - `h2h`, `threeWay`, `titleGame`: the corner cases.
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
  conference games left in the last three weeks: about 24 or fewer runs in under a minute.
  Leagues without a total-wins step skip non-conference games. Larger counts fall back to
  simulation, with no change needed.
- **Look at it:**

  ```bash
  python3 fetch_data.py --league <id> --data-out /tmp/<id>.json --site /tmp/site
  ```

  Then serve `/tmp/site`. Check both themes and a phone-width window. Open a few teams whose
  paths need a tiebreak and read the sentences.
- **CSS:** `app.html` is one stylesheet. New class names can collide with existing ones. The
  header's `.bar` once took on the rooting guide's 6px progress bar.

## Notes for the ACC

These are starting points to verify, not facts to build on.

- ESPN group **1**. 17 teams in 2026: MIA, WAKE, SMU, DUKE, LOU, CLEM, PITT, VT, UNC, FSU, STAN,
  UVA, NCSU, BC, SYR, CAL, GT. Notre Dame isn't in the standings.
- The ACC said in 2025 it would update its tiebreaker for the 2026 season, as it moves toward
  more conference games. Find the 2026 version, and check whether every team plays the same
  number of conference games. Unequal schedules make the difference between averaging opponents'
  percentages and combining their records real (the site combines them).
- The 2025 ACC race reportedly ended in a large tie with Duke reaching the title game at 6-2. If
  that holds up, it's the regression test to start with.
