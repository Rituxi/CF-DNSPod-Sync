import assert from "node:assert/strict";
import test from "node:test";
import worker, { dueTask, onClock, dispatchTask } from "../src/actions-trigger.ts";
const token = "test-trigger-token", env = { GITHUB_DISPATCH_TOKEN: token, DISPATCH_ENABLED: "true" };
const run = { workflow_run_id: 123, html_url: "https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/123" };
const at = Date.parse("2026-10-26T04:33:00Z");

test("one lightweight clock preserves exactly 48 sync and 96 probe starts per UTC day", () => {
  const tasks = [];
  for (let minute = 0; minute < 1440; minute++) {
    const timestamp = Date.parse("2026-10-26T00:00:00Z") + minute * 60000;
    if (dueTask(timestamp)) tasks.push({ minute, task: dueTask(timestamp) });
  }
  assert.equal(tasks.filter(item => item.task === "sync").length, 48);
  assert.equal(tasks.filter(item => item.task === "probe").length, 96);
  assert.deepEqual(tasks.slice(0, 6), [{ minute: 3, task: "sync" }, { minute: 10, task: "probe" }, { minute: 25, task: "probe" },
    { minute: 33, task: "sync" }, { minute: 40, task: "probe" }, { minute: 55, task: "probe" }]);
});

test("paused and unrelated clock minutes stay offline without credentials", async () => {
  const offline = () => { assert.fail("No API request expected"); };
  assert.equal((await onClock({ scheduledTime: at }, { DISPATCH_ENABLED: "false" }, offline)).status, "paused");
  assert.equal((await onClock({ scheduledTime: at + 60000 }, env, offline)).status, "held");
});

test("a scheduled tick makes one scoped API request and returns its actual run identity", async () => {
  let calls = 0;
  const result = await onClock({ scheduledTime: at }, env, async (url, options) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/Rituxi/CF-DNSPod-Sync/actions/workflows/sync.yml/dispatches");
    assert.equal(options.method, "POST"); assert.equal(options.redirect, "manual");
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.headers["x-github-api-version"], "2026-03-10");
    assert.deepEqual(JSON.parse(options.body), { ref: "main", inputs: { trigger_source: "cloudflare-cron", scheduled_at: new Date(at).toISOString(), mode: "apply" } });
    return Response.json(run);
  });
  assert.equal(calls, 1); assert.equal(result.runId, 123); assert.equal(result.dnsWrites, false);
});

test("a temporary clock delivery check can only start frozen sync and obeys pause", async () => {
  const validation = { ...env, CLOCK_VALIDATE_FROZEN_SYNC: "true" };
  const result = await onClock({ scheduledTime: at + 60000 }, validation, async (_url, options) => {
    const { inputs } = JSON.parse(options.body);
    assert.equal(inputs.mode, "frozen"); assert.equal(inputs.trigger_source, "clock-validation"); return Response.json(run);
  });
  assert.equal(result.task, "sync");
  assert.equal((await onClock({ scheduledTime: at }, { ...validation, DISPATCH_ENABLED: "false" }, () => assert.fail("Paused clock must stay offline"))).status, "paused");
});

test("probe dispatch carries boolean freeze inputs and a separate validation source", async () => {
  for (const frozen of [true, false]) await dispatchTask(env, "probe", at, { frozen, validation: true, fetcher: async (_url, options) => {
    const { inputs } = JSON.parse(options.body);
    assert.equal(inputs.require_frozen, frozen); assert.equal(typeof inputs.require_frozen, "boolean");
    assert.equal(inputs.trigger_source, "clock-validation"); return Response.json(run);
  } });
});

test("API refusal or ambiguous acceptance never retries or exposes upstream bodies", async () => {
  for (const status of [204, 301, 401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(dispatchTask(env, "sync", at, { fetcher: async () => {
      calls++; return new Response(status === 204 ? null : "private-upstream-token", { status });
    } }), error => { assert.match(error.message, new RegExp(`HTTP ${status}`)); assert.doesNotMatch(error.message, /private-upstream-token/); return true; });
    assert.equal(calls, 1);
  }
  await assert.rejects(dispatchTask(env, "sync", at, { fetcher: async () => Response.json({ ...run, html_url: "https://github.com/other/repo/actions/runs/123" }) }), /identity was not verified/);
});

test("active validation is authenticated and cannot request an unfrozen publication", async () => {
  const nativeFetch = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).inputs.mode, "frozen"); return Response.json(run);
    };
    const request = (secret, task = "sync") => new Request("https://clock.test/dispatch", { method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ task, frozen: false }) });
    assert.equal((await worker.fetch(request("wrong"), env)).status, 401);
    assert.equal((await worker.fetch(request(token, "unfreeze"), env)).status, 400); assert.equal(calls, 0);
    const response = await worker.fetch(request(token), { ...env, DISPATCH_ENABLED: "false" });
    assert.equal(response.status, 200); assert.equal((await response.json()).triggerSource, "clock-validation"); assert.equal(calls, 1);
  } finally { globalThis.fetch = nativeFetch; }
});
