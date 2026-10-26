import { appendFile } from "node:fs/promises";

// Only an explicit summary is written to public Actions logs. Full reports stay
// in the tool's D1; local CLI output and ignored result files remain available.
export function summarize(kind, result) {
  return {
    kind, at: result.at ?? result.fetchedAt ?? new Date(result.startedAt ?? Date.now()).toISOString(),
    status: result.status, reason: result.reason, strategy: result.strategy,
    frozen: result.frozen, publicationAllowed: result.publicationAllowed, dnsWrites: result.dnsWrites,
    sources: result.sources, sourceError: result.sourceError,
    decisions: result.decisions?.map(({ line, kind, reason, ip, evidence }) => ({ line, kind, reason, ip, evidence })),
    outcomes: result.outcomes,
    line: result.line, roundId: result.id, validForLine: result.validForLine,
    requestedTests: result.requestedTests, errors: result.errors,
    reports: result.reports?.map(({ target, checked, successful, carriers, completeCoverage, reportUrl }) =>
      ({ target, checked, successful, carriers, completeCoverage, reportUrl })),
    countedSubrequests: result.countedSubrequests,
  };
}
export async function outputResult(kind, result) {
  if (process.env.GITHUB_ACTIONS !== "true") { console.log(JSON.stringify(result, null, 2)); return; }
  const summary = summarize(kind, result);
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### ${kind}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`);
  if (result.status === "partial" || result.sourceError || result.sources?.some(source => source.status === "unavailable")) {
    console.log("::warning::Collection was incomplete; inspect the summary. Existing DNS is retained unless a separately verified update is reported.");
  }
}
