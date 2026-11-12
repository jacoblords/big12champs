// Starts the "Update data and deploy" workflow on a clock GitHub doesn't throttle.
//
// GitHub runs scheduled workflows on a best-effort basis, and for this repo that came out as
// once every 4-8 hours instead of every 15-30 minutes. A Cloudflare cron trigger fires on time,
// and a workflow_dispatch it sends starts at once. The schedule lives in wrangler.toml.
//
// The dispatch passes force=false, so the run deploys only when ESPN data changed, exactly like
// a scheduled run. A click on "Run workflow" in GitHub still defaults to a forced rebuild.

const API = "https://api.github.com";

async function dispatch(env, fetchFn = fetch) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set (wrangler secret put GITHUB_TOKEN)");
  const url = `${API}/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "titlepaths-trigger (cloudflare cron)",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.REF, inputs: { force: "false" } }),
  });
  // 204 normally; 200 if GitHub ever answers with run details. A failure throws so the
  // Cloudflare dashboard marks the invocation failed and logs why (401 = expired token).
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`GitHub answered ${res.status} to the dispatch: ${detail}`);
  }
}

export default {
  async scheduled(_controller, env) {
    await dispatch(env);
  },
  dispatch, // for tests/trigger.test.js
};
