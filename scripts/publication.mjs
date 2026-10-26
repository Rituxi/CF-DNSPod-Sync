import { mkdir, writeFile } from "node:fs/promises";
import { StateStore } from "../src/state.ts";
import { loadConfig, remoteState } from "./runtime.mjs";
const command = process.argv[2] ?? "status";
if (!["freeze", "resume", "status"].includes(command)) throw new Error("Use freeze, resume or status");
const store = new StateStore(remoteState(await loadConfig()));
if (command !== "status") await store.freeze(command === "freeze", Date.now());
const control = await store.control();
const lines = await store.lines();
const rounds = await store.rounds(Date.now());
const report = { at: new Date().toISOString(), publicationFrozen: !!control.frozen,
  frozenAt: control.frozen_at ? new Date(control.frozen_at).toISOString() : null,
  earliestItdogAt: control.frozen && control.frozen_at ? new Date(control.frozen_at + 600_000).toISOString() : null,
  lineStates: lines.map(line => ({ line: line.line, ip: line.record.Value, version: line.version, authorityReadAt: new Date(line.fetchedAt).toISOString(),
    candidates: line.candidates, decision: line.decision, backups: line.backups })),
  rounds: rounds.map(round => ({ id: round.id, line: round.line, startedAt: new Date(round.startedAt).toISOString(), status: round.status,
    reports: round.reports.map(report => ({ target: report.target, checked: report.checked, successful: report.successful, carriers: report.carriers, reportUrl: report.reportUrl })), errors: round.errors })),
};
await mkdir(new URL("../.local/", import.meta.url), { recursive: true });
await writeFile(new URL(`../.local/publication-${Date.now()}.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
