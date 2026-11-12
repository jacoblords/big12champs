// The Cloudflare Worker in trigger/ that starts update.yml: what it sends GitHub, and that a
// refused dispatch fails loudly instead of silently stopping updates.
const test = require("node:test");
const assert = require("node:assert");

const env = { GITHUB_TOKEN: "t0ken", REPO: "jacoblords/big12champs", WORKFLOW: "update.yml", REF: "main" };
const load = () => import("../trigger/worker.mjs").then((m) => m.default);

test("dispatches update.yml on main with force=false", async () => {
  const { dispatch } = await load();
  const calls = [];
  await dispatch(env, async (url, init) => (calls.push({ url, init }), new Response(null, { status: 204 })));
  assert.strictEqual(calls.length, 1);
  const { url, init } = calls[0];
  assert.strictEqual(url, "https://api.github.com/repos/jacoblords/big12champs/actions/workflows/update.yml/dispatches");
  assert.strictEqual(init.method, "POST");
  assert.strictEqual(init.headers.Authorization, "Bearer t0ken");
  assert.ok(init.headers["User-Agent"]);
  assert.deepStrictEqual(JSON.parse(init.body), { ref: "main", inputs: { force: "false" } });
});

test("a refused dispatch throws with GitHub's status", async () => {
  const { dispatch } = await load();
  const reply = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
  await assert.rejects(dispatch(env, reply), /401.*Bad credentials/);
});

test("a missing token throws before calling GitHub", async () => {
  const { dispatch } = await load();
  let called = false;
  await assert.rejects(dispatch({ ...env, GITHUB_TOKEN: "" }, async () => ((called = true), new Response())), /GITHUB_TOKEN/);
  assert.strictEqual(called, false);
});

test("the workflow accepts the force input the worker sends", () => {
  const yml = require("fs").readFileSync(require("path").join(__dirname, "../.github/workflows/update.yml"), "utf8");
  assert.match(yml, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*force:/);
  assert.match(yml, /github\.event\.inputs\.force != 'false'/);
});
