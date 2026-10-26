import { writeFile, mkdir } from "node:fs/promises";
import { runRemoteProbe } from "./src/remote-probe.ts";
import { loadRuntime, remoteState } from "./scripts/runtime.mjs";
import { StateStore } from "./src/state.ts";
import { outputResult } from "./scripts/report.mjs";
try {
  const config = await loadRuntime("probe");
  const STATE = remoteState(config);
  if (process.env.REQUIRE_PUBLICATION_FROZEN === "true" && !(await new StateStore(STATE).control()).frozen) {
    throw new Error("Frozen validation requires publication to remain frozen");
  }
  const result = await runRemoteProbe({ ...config.vars, STATE });
  result.stateUsage = STATE.usage;
  if (typeof result.countedSubrequests === "number") result.countedSubrequests += STATE.usage.metadataRequests;
  await mkdir(new URL("./.local/", import.meta.url), { recursive: true });
  await writeFile(new URL(`./.local/success-probe-${Date.now()}.json`, import.meta.url), JSON.stringify(result, null, 2));
  await outputResult("probe", result);
} catch (error) { console.error(error instanceof Error ? error.message : "Probe failed"); process.exitCode = 1; }
