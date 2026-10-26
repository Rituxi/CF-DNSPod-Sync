import assert from "node:assert/strict";
import test from "node:test";
import { credentials, remoteState } from "../scripts/runtime.mjs";
import { cfRequest } from "../scripts/cloudflare-api.mjs";
import { summarize } from "../scripts/report.mjs";

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
  const result = summarize("probe", { status: "partial", dnsWrites: false, states: [{ private: true }], allocations: [{ private: true }],
    errors: [{ target: "104.16.0.1", error: "incomplete" }],
    reports: [{ target: "104.16.0.1", checked: 9, successful: 6, carriers: [], results: [{ private: true }] }] });
  assert.equal(result.errors[0].error, "incomplete");
  assert.equal(result.reports[0].checked, 9); assert.equal(result.reports[0].successful, 6);
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("REST state usage sums per-statement metadata and never changes parameterized SQL", async () => {
  const scope = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111" };
  const config = { account_id: scope.accountId, d1_databases: [{ binding: "STATE", database_name: "cf-dnspod-state", database_id: scope.databaseId }] };
  const requests = [];
  const db = remoteState(config, async (_path, { body }) => {
    requests.push(body);
    return (body.batch ?? [body]).map(() => ({ success: true, results: [], meta: { rows_read: 4, rows_written: 1 } }));
  }, scope);
  await db.prepare("SELECT ? value").bind("first").all();
  await db.batch([db.prepare("SELECT ? value").bind("second"), db.prepare("SELECT ? value").bind("third")]);
  assert.deepEqual(db.usage, { requests: 2, rowsRead: 12, rowsWritten: 3 });
  assert.deepEqual(requests[1].batch, [{ sql: "SELECT ? value", params: ["second"] }, { sql: "SELECT ? value", params: ["third"] }]);
});
