import { readFile } from "node:fs/promises";
import { cfRequest } from "./cloudflare-api.mjs";
import { ACCOUNT, DATABASE_ID, requireStateScope } from "./resources.mjs";
export async function loadConfig(name = "wrangler.jsonc") {
  const config = JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
  if (ACCOUNT) config.account_id = ACCOUNT;
  for (const binding of config.d1_databases ?? []) if (binding.binding === "STATE" && DATABASE_ID) binding.database_id = DATABASE_ID;
  return config;
}
export async function credentials() {
  if (process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY) return {
    TENCENTCLOUD_SECRET_ID: process.env.TENCENTCLOUD_SECRET_ID, TENCENTCLOUD_SECRET_KEY: process.env.TENCENTCLOUD_SECRET_KEY,
  };
  if (process.env.GITHUB_ACTIONS === "true" || process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRET_KEY) {
    throw new Error("Missing TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY Actions secrets");
  }
  try { return JSON.parse(await readFile(new URL("../.local/dnspod-credentials.json", import.meta.url), "utf8")); }
  catch { throw new Error("No local Tencent credentials. Run: pwsh -File scripts/set-credentials.ps1"); }
}
export function remoteState(config, request = cfRequest, scope) {
  const path = requireStateScope(config, scope);
  const usage = { requests: 0, rowsRead: 0, rowsWritten: 0 };
  const account = results => {
    for (const result of results ?? []) {
      usage.rowsRead += result.meta?.rows_read ?? 0;
      usage.rowsWritten += result.meta?.rows_written ?? 0;
    }
    return results;
  };
  const query = async (sql, params) => {
    usage.requests++;
    const results = account(await request(path, { method: "POST", body: { sql, params } }));
    if (!results?.[0] || results.some(result => result.success === false)) throw new Error("Dedicated state query failed");
    return results[0];
  };
  return {
    usage,
    prepare(sql) {
      return { sql, values: [], bind(...values) { this.values = values; return this; },
        all() { return query(this.sql, this.values); }, run() { return query(this.sql, this.values); } };
    },
    async batch(statements) {
      usage.requests++;
      const results = account(await request(path, { method: "POST", body: { batch: statements.map(statement => ({ sql: statement.sql, params: statement.values })) } }));
      if (!Array.isArray(results) || results.length !== statements.length || results.some(result => result.success === false)) throw new Error("Dedicated state transaction failed");
      return results;
    },
  };
}
