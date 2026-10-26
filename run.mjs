import { mkdir, writeFile } from "node:fs/promises";
import { synchronize } from "./src/sync.ts";
import { readCandidates } from "./src/sources.ts";
import { loadConfig, credentials, remoteState } from "./scripts/runtime.mjs";
import { outputResult } from "./scripts/report.mjs";
try {
  const args = process.argv.slice(2), flag = args[0] ?? "--observe";
  if (!["--observe", "--plan", "--apply"].includes(flag)) throw new Error("Use --observe, --plan or --apply [--ranked-fallback=CT|CU|CM|DEFAULT]");
  const fallback = args[1]?.match(/^--ranked-fallback=(CT|CU|CM|DEFAULT)$/)?.[1];
  if (args.length > 2 || (args.length === 2 && (!fallback || flag !== "--apply"))) throw new Error("Ranked fallback requires explicit --apply --ranked-fallback=LINE");
  let result;
  const directory = new URL("./.local/", import.meta.url); await mkdir(directory, { recursive: true });
  const stamp = Date.now();
  const save = (suffix, value) => writeFile(new URL(`success-sync-${stamp}-${suffix}.json`, directory), JSON.stringify(value, null, 2) + "\n");
  if (flag === "--observe") result = { status: "observed", ...await readCandidates(), dnsWrites: false };
  else {
    const config = await loadConfig();
    const env = { ...config.vars, ...await credentials(), STATE: remoteState(config) };
    result = await synchronize(env, { dryRun: flag === "--plan", requireFrozen: process.env.REQUIRE_PUBLICATION_FROZEN === "true",
      manualRankedLine: fallback, beforeApply: plan => save("plan", plan) });
    result.stateUsage = env.STATE.usage;
  }
  await save("result", result); await outputResult(flag.slice(2), result);
} catch (error) { console.error(error instanceof Error ? error.message : "DNSPod sync failed"); process.exitCode = 1; }
