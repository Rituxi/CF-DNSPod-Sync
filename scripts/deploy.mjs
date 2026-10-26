import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ACCOUNT, WRANGLER_PROFILE } from "./resources.mjs";
const target = process.argv[2] ?? "trigger";
const files = { test: "wrangler.test.jsonc", trigger: "wrangler.trigger.jsonc" };
if (!Object.hasOwn(files, target) || process.argv.slice(3).some(arg => arg !== "--dry-run")) throw new Error("Use deploy.mjs test|trigger [--dry-run]");
if (!ACCOUNT) throw new Error("Missing CLOUDFLARE_ACCOUNT_ID deployment configuration");
const config = JSON.parse(await readFile(new URL(`../${files[target]}`, import.meta.url), "utf8"));
config.account_id = ACCOUNT;
const directory = new URL("../.local/", import.meta.url); await mkdir(directory, { recursive: true });
config.main = fileURLToPath(new URL(`../${config.main}`, import.meta.url));
delete config.$schema;
const configFile = new URL(`deploy-${target}.json`, directory);
await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
  "deploy", "--config", fileURLToPath(configFile), ...(WRANGLER_PROFILE ? ["--profile", WRANGLER_PROFILE] : []), ...process.argv.slice(3)],
  { stdio: "inherit", windowsHide: true });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
