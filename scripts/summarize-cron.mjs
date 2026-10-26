import { readFile, writeFile } from "node:fs/promises";
const results = [];
for (const name of ["sync-cron", "probe-cron"]) {
  const file = new URL(`../.local/${name}.jsonl`, import.meta.url);
  const text = await readFile(file, "utf8");
  const rows = text.trim().split(/\r?\n(?=\{)/).filter(Boolean).flatMap(chunk => {
    try { return [JSON.parse(chunk)]; } catch { return []; } // A live tail may end mid-event.
  });
  for (const row of rows) {
    const logs = (row.logs ?? []).flatMap(log => log.message ?? []).flatMap(message => {
      try { return [JSON.parse(message)]; } catch { return []; }
    });
    results.push({ script: row.scriptName, outcome: row.outcome, event: row.event, exceptions: row.exceptions,
      logs: logs.map(log => ({ event: log.event, status: log.status, fetchedAt: log.fetchedAt, dnsWrites: log.dnsWrites,
        changes: log.changes, verified: log.verified, errors: log.errors,
        reports: log.reports?.map(report => ({ target: report.target, checked: report.checked, successful: report.successful,
          completeCoverage: report.completeCoverage, carriers: report.carriers, reportUrl: report.reportUrl })) })) });
  }
}
await writeFile(new URL("../.local/cron-acceptance.json", import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
