import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ACCOUNT, WRANGLER_PROFILE } from "./resources.mjs";
const targets = { trigger: "cf-dnspod-actions-trigger", test: "cf-ipv4-test" };
const target = process.argv[2] ?? "trigger";
if (!Object.hasOwn(targets, target)) throw new Error("Choose trigger or test logs");
if (!ACCOUNT) throw new Error("Missing CLOUDFLARE_ACCOUNT_ID configuration");
const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
  "tail", targets[target], "--config", fileURLToPath(new URL(`../wrangler.${target}.jsonc`, import.meta.url)),
  "--format", "json", ...(WRANGLER_PROFILE ? ["--profile", WRANGLER_PROFILE] : [])],
  { stdio: "inherit", windowsHide: true, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
