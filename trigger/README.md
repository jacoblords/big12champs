# Update trigger and live scores

A Cloudflare Worker with two jobs:

- **Trigger:** start `.github/workflows/update.yml` every 15 minutes Thursday through Sunday and
  every 30 minutes Monday to Wednesday (UTC; see `wrangler.toml`).
- **Live scores:** `GET /live?ids=<ESPN game ids>` gives the gameday pages the score, clock and
  win-probability chart of games under way, every 30 seconds. All requests go through one Durable
  Object holding a shared copy per game, so ESPN gets at most one summary call per game every 30
  seconds however many people are watching (one Gamecast viewer asks far more often), and none
  once ESPN calls the game final. Seeing a game go final, it starts the workflow once, so the
  result and odds land in a minute or two. Browsers may read it from titlepaths.com (`ORIGINS`)
  and localhost.

GitHub's own `schedule:` trigger is best-effort, and in November 2026 it fired only every 4-8
hours here. Cloudflare cron triggers fire on time and are free. The workflow keeps an hourly
GitHub schedule as a backup, so updates slow down rather than stop if this worker breaks.

Runs it starts pass `force=false` and so behave like scheduled runs: they deploy only when ESPN
data changed. A manual "Run workflow" click in GitHub still rebuilds and deploys by default.

## Setup (once)

1. **Token.** On GitHub, open Settings → Developer settings → Fine-grained personal access
   tokens → Generate new token. Set *Repository access* to only `big12champs`, and under
   *Repository permissions* set **Actions** to *Read and write* (Metadata: read-only is added
   automatically). Nothing else. Pick an expiration and note it.
2. **Deploy** from this directory:

   ```bash
   npx wrangler@4 login
   npx wrangler@4 deploy
   npx wrangler@4 secret put GITHUB_TOKEN
   ```

   Paste the token at the last prompt. It goes straight to Cloudflare and is never in the repo.
3. **Live scores.** `wrangler deploy` prints the worker's address,
   `https://titlepaths-trigger.<your subdomain>.workers.dev`. Set it as a repository variable
   (GitHub → Settings → Secrets and variables → Actions → Variables) named `LIVE_URL`, or:

   ```bash
   gh variable set LIVE_URL --body https://titlepaths-trigger.<subdomain>.workers.dev
   ```

   The next deploy puts it in the gameday pages. Unset, the pages simply don't poll. Check it
   with `curl "$LIVE_URL/live?ids=<an ESPN game id>"`.

## Checking on it

- GitHub's Actions tab lists its runs with the event `workflow_dispatch`.
- The Cloudflare dashboard (Workers → titlepaths-trigger → Logs) shows each cron invocation and
  /live request; a failed workflow start on a final is logged as `final <id>: …`. A
  failed one says why: `401` means the token expired or was revoked. Make a new one and run
  `npx wrangler@4 secret put GITHUB_TOKEN` again; nothing else needs redeploying.
