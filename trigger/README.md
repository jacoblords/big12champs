# Update trigger

A Cloudflare Worker whose only job is to start `.github/workflows/update.yml` every 15 minutes
Thursday through Sunday and every 30 minutes Monday to Wednesday (UTC; see `wrangler.toml`).

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

## Checking on it

- GitHub's Actions tab lists its runs with the event `workflow_dispatch`.
- The Cloudflare dashboard (Workers → titlepaths-trigger → Logs) shows each cron invocation. A
  failed one says why: `401` means the token expired or was revoked. Make a new one and run
  `npx wrangler@4 secret put GITHUB_TOKEN` again; nothing else needs redeploying.
