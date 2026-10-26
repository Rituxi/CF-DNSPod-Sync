import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { credentials, remoteState, loadRuntime } from "../scripts/runtime.mjs";
import { cfRequest } from "../scripts/cloudflare-api.mjs";
import { summarize } from "../scripts/report.mjs";
import { publishTriggerToken } from "../scripts/publish-trigger-token.mjs";

test("Actions uses its API token, refuses interactive/local credential fallback and hides API error details", async () => {
  const names = ["GITHUB_ACTIONS", "CLOUDFLARE_API_TOKEN", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY"];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]])), nativeFetch = globalThis.fetch;
  try {
    process.env.GITHUB_ACTIONS = "true";
    for (const name of names.slice(1)) delete process.env[name];
    await assert.rejects(credentials(), /Actions secrets/);
    await assert.rejects(cfRequest("/unused"), /interactive Wrangler authentication is disabled/);
    process.env.CLOUDFLARE_API_TOKEN = "test-api-token";
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.authorization, "Bearer test-api-token");
      assert.equal(init.redirect, "manual");
      return Response.json({ success: true, result: [{ success: true, results: [{ frozen: 1 }] }] });
    };
    assert.equal((await cfRequest("/unused", { method: "POST", body: { sql: "SELECT 1" } }))[0].success, true);
    globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 9109, message: "private-diagnostic" }] }, { status: 403 });
    await assert.rejects(cfRequest("/private-account/database"), error => {
      assert.match(error.message, /HTTP 403, codes 9109/);
      assert.doesNotMatch(error.message, /private|token/); return true;
    });
    process.env.TENCENTCLOUD_SECRET_ID = "test-id";
    await assert.rejects(credentials(), /Actions secrets/);
    process.env.TENCENTCLOUD_SECRET_KEY = "test-key";
    assert.deepEqual(await credentials(), { TENCENTCLOUD_SECRET_ID: "test-id", TENCENTCLOUD_SECRET_KEY: "test-key" });
  } finally {
    globalThis.fetch = nativeFetch;
    for (const name of names) if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
  }
});

test("public Actions summaries preserve failures and exclude raw state and probe payloads", () => {
  const result = summarize("probe", { status: "partial", dnsWrites: false, states: [{ line: "CT", fetchedAt: 1,
    record: { Value: "104.16.0.1", UpdatedOn: "2026-10-25 21:45:40" }, private: true }], allocations: [{ private: true }],
    errors: [{ target: "104.16.0.1", error: "incomplete" }],
    reports: [{ target: "104.16.0.1", checked: 9, successful: 6, carriers: [], results: [{ private: true }] }] });
  assert.equal(result.errors[0].error, "incomplete");
  assert.equal(result.reports[0].checked, 9); assert.equal(result.reports[0].successful, 6);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(result.currentRecords[0].dnsUpdatedOn, "2026-10-25 21:45:40");
  assert.equal(result.currentRecords[0].lastCheckedAt, "1970-01-01T00:00:00.001Z");
});

test("REST state usage sums per-statement metadata and never changes parameterized SQL", async () => {
  const scope = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111" };
  const config = { database: { accountId: scope.accountId, name: "cf-dnspod-state", id: scope.databaseId } };
  const requests = [];
  let identityChecks = 0;
  const db = remoteState(config, async (path, request) => {
    if (!path.endsWith("/query")) { identityChecks++; return { uuid: scope.databaseId, name: "cf-dnspod-state" }; }
    const { body } = request;
    requests.push(body);
    return (body.batch ?? [body]).map(() => ({ success: true, results: [], meta: { rows_read: 4, rows_written: 1 } }));
  }, scope);
  await db.prepare("SELECT ? value").bind("first").all();
  await db.batch([db.prepare("SELECT ? value").bind("second"), db.prepare("SELECT ? value").bind("third")]);
  assert.equal(identityChecks, 1);
  assert.deepEqual(db.usage, { requests: 3, metadataRequests: 1, rowsRead: 12, rowsWritten: 3 });
  assert.deepEqual(requests[1].batch, [{ sql: "SELECT ? value", params: ["second"] }, { sql: "SELECT ? value", params: ["third"] }]);
});

test("a mismatched server-side database identity sends no SQL", async () => {
  const scope = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111" };
  const config = { database: { accountId: scope.accountId, name: "cf-dnspod-state", id: scope.databaseId } };
  for (const metadata of [{ uuid: scope.databaseId, name: "other-database" }, { uuid: "wrong-id", name: "cf-dnspod-state" }]) {
    let requests = 0;
    const db = remoteState(config, async (path, options) => {
      requests++; assert.ok(!path.endsWith("/query")); assert.equal(options, undefined); return metadata;
    }, scope);
    await assert.rejects(db.prepare("UPDATE tool_control SET frozen=0").run(), /no SQL was sent/);
    await assert.rejects(db.batch([db.prepare("SELECT 1")]), /no SQL was sent/);
    assert.equal(requests, 1); assert.equal(db.usage.rowsWritten, 0);
  }
});

test("Node configuration is independent of Worker deployment files", async () => {
  const sync = await loadRuntime(), probe = await loadRuntime("probe");
  assert.equal(sync.vars.DNSPOD_DOMAIN, "pick.luro.qzz.io"); assert.equal(probe.vars.TARGET_RECORD, sync.vars.DNSPOD_DOMAIN);
  assert.equal(sync.database.name, "cf-dnspod-state"); assert.deepEqual(sync.database, probe.database);
  await assert.rejects(loadRuntime("wrangler.jsonc"), /Node runtime/);
});

test("the retired ranking shortcut is rejected before any network request", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../run.mjs", import.meta.url)), "--apply", "--ranked-fallback=CU"],
    { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use --observe, --plan or --apply/);
});

test("an unusable rotation token cannot overwrite the clock secret", async () => {
  let writes = 0;
  const request = async () => { writes++; };
  const accountId = "a".repeat(32);
  await assert.rejects(publishTriggerToken("github_pat_test", { accountId, request,
    fetcher: async () => new Response("private-response", { status: 403 }) }), /HTTP 403/);
  assert.equal(writes, 0);
  const result = await publishTriggerToken("github_pat_test", { accountId, request: async (path, options) => {
    writes++; assert.equal(path, `/accounts/${accountId}/workers/scripts/cf-dnspod-actions-trigger/secrets`);
    assert.equal(options.body.text, "github_pat_test");
  }, fetcher: async (url, options) => {
    assert.ok(url.endsWith("/sync.yml/dispatches"));
    assert.equal(JSON.parse(options.body).inputs.mode, "plan");
    return Response.json({ workflow_run_id: 123, html_url: "https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/123" });
  } });
  assert.equal(writes, 1); assert.equal(result.runId, 123);
});
