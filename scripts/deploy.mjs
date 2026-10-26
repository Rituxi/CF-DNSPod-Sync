import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./runtime.mjs";
import { ACCOUNT, WRANGLER_PROFILE, requireStateScope } from "./resources.mjs";
const target = process.argv[2] ?? "test";
const files = { sync: "wrangler.jsonc", probe: "wrangler.probe.jsonc", test: "wrangler.test.jsonc", trigger: "wrangler.trigger.jsonc" };
if (!Object.hasOwn(files, target) || process.argv.slice(3).some(arg => arg !== "--dry-run")) throw new Error("Use deploy.mjs sync|probe|test|trigger [--dry-run]");
if (!ACCOUNT) throw new Error("Missing CLOUDFLARE_ACCOUNT_ID deployment configuration");
const config = await loadConfig(files[target]);
if (["sync", "probe"].includes(target)) requireStateScope(config);
const directory = new URL("../.local/", import.meta.url); await mkdir(directory, { recursive: true });
config.main = fileURLToPath(new URL(`../${config.main}`, import.meta.url));
for (const binding of config.d1_databases ?? []) binding.migrations_dir = fileURLToPath(new URL("../migrations/", import.meta.url));
delete config.$schema;
const configFile = new URL(`deploy-${target}.json`, directory);
await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
  "deploy", "--config", fileURLToPath(configFile), ...(WRANGLER_PROFILE ? ["--profile", WRANGLER_PROFILE] : []), ...process.argv.slice(3)],
  { stdio: "inherit", windowsHide: true });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
