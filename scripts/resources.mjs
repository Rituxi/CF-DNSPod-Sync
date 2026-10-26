import { readFile } from "node:fs/promises";

// Identifiers are deployment configuration, not credentials. Keep this machine's
// values outside Git; Actions supplies repository variables instead.
let local = {};
try { local = JSON.parse(await readFile(new URL("../.local/cloudflare-state.json", import.meta.url), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
export const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? local.accountId ?? "";
export const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID ?? local.databaseId ?? "";
export const WRANGLER_PROFILE = process.env.WRANGLER_PROFILE ?? local.wranglerProfile ?? "";

export function requireStateScope(config, scope = { accountId: ACCOUNT, databaseId: DATABASE_ID }) {
  const binding = config.d1_databases?.find(item => item.binding === "STATE");
  if (!/^[a-f0-9]{32}$/.test(scope.accountId) || !/^[a-f0-9-]{36}$/.test(scope.databaseId) ||
    config.account_id !== scope.accountId || binding?.database_name !== "cf-dnspod-state" || binding.database_id !== scope.databaseId) {
    throw new Error("CLI may only access the configured dedicated tool state database");
  }
  return `/accounts/${scope.accountId}/d1/database/${scope.databaseId}/query`;
}
