import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ACCOUNT, WRANGLER_PROFILE } from "./resources.mjs";

export { ACCOUNT };
let oauth;
async function oauthToken() {
  if (process.env.GITHUB_ACTIONS === "true") throw new Error("Missing CLOUDFLARE_API_TOKEN Actions secret; interactive Wrangler authentication is disabled in Actions");
  // Let Wrangler refresh its own named-profile token; never print or persist it here.
  oauth ??= (async () => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
        "auth", "token", ...(WRANGLER_PROFILE ? ["--profile", WRANGLER_PROFILE] : []), "--json",
      ], { cwd: fileURLToPath(new URL("../", import.meta.url)), windowsHide: true, timeout: 60_000,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
      const auth = JSON.parse(stdout);
      if (auth.type !== "oauth" || typeof auth.token !== "string" || !auth.token) throw new Error();
      return auth.token;
    } catch { throw new Error("Local Wrangler login unavailable; authenticate the configured profile or supply CLOUDFLARE_API_TOKEN"); }
  })();
  return oauth;
}
export async function cfRequest(apiPath, { method = "GET", body } = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || await oauthToken();
  const response = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw new Error(`Cloudflare ${method}: HTTP ${response.status}, codes ${result.errors?.map(error => error.code).join(",")}`);
  return result.result;
}
