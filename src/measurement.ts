import { POLICY, TEST_SERVICE, type Line } from "./config.ts";

export const CARRIERS = [
  { line: "CT" as Line, name: "电信", asn: 4134 },
  { line: "CU" as Line, name: "联通", asn: 4837 },
  { line: "CM" as Line, name: "移动", asn: 9808 },
];
export interface Sample {
  country: string; city: string; state: string | null; asn: number; network: string;
  latitude: number | null; longitude: number | null;
  ok: boolean; collectionIssue: string | null; failure: string | null;
  httpStatus: number | null; tlsAuthorized: boolean; ip: string | null; totalMs: number | null;
  failureSource: string | null; diagnostic: string; overBudget: boolean;
}
export interface Measurement {
  measurementId: string; reportUrl: string; target: string; allocated: number;
  completeCoverage: boolean; checked: number; successful: number; results: Sample[];
  failureCounts: Record<string, number>; collectionIssueCounts: Record<string, number>;
  carriers: { line: Line; name: string; asn: number; samples: number; successful: number; failed: number; collectionIssues: number; successfulP95Ms: number | null; failureCounts: Record<string, number> }[];
}
// The decision reader and comparison functions share this contract. Full reports
// remain stored; adding a comparison input here also adds it to the Actions projection.
export const COMPARISON_SAMPLE_KEYS = [
  "country", "asn", "state", "city", "network", "latitude", "longitude", "collectionIssue", "totalMs", "ok",
] as const;
export type ComparisonSample = Pick<Sample, typeof COMPARISON_SAMPLE_KEYS[number]>;
export type ComparisonMeasurement = Pick<Measurement, "target" | "allocated"> & { results: ComparisonSample[] };
export const p95 = (times: number[]): number | null => {
  if (!times.length) return null;
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
};

function normalize(row: any, target: string): Sample {
  const result = row.result ?? {}, probe = row.probe ?? {};
  const validLocation = probe.country === "CN" && CARRIERS.some(carrier => carrier.asn === probe.asn) &&
    typeof probe.city === "string" && probe.city.length > 0 && typeof probe.network === "string";
  let body: any; try { body = JSON.parse(result.rawBody); } catch { /* Wrong JSON cannot succeed. */ }
  const totalMs = typeof result.timings?.total === "number" && Number.isFinite(result.timings.total) && result.timings.total >= 0 ? result.timings.total : null;
  const diagnostic = typeof result.rawOutput === "string" ? result.rawOutput.slice(-1000) : "";
  let collectionIssue: string | null = null, failure: string | null = null;
  if (!validLocation) collectionIssue = "unexpected-probe-location";
  else if (["offline", "in-progress"].includes(result.status)) collectionIssue = `probe-${result.status}`;
  else if (result.status === "failed" && result.failureSource === "internal") collectionIssue = "provider-internal";
  else if (result.status === "failed" && !["target", "resolver"].includes(result.failureSource)) collectionIssue = "failure-source-unknown";
  else if (result.status === "failed") {
    // Only explicit diagnostics refine the provider's structured failureSource.
    // These labels do not decide winners; every confirmed target failure stays in the denominator.
    if (result.failureSource === "resolver" || /Could not resolve|ENOTFOUND|EAI_AGAIN/i.test(diagnostic)) failure = "dns";
    else if (result.tls?.authorized === false || /curl:\s*\(60\)|certificate verify failed/i.test(diagnostic)) failure = "tls";
    else if (/curl:\s*\(28\)|ETIMEDOUT|\btimed out\b|timeout was reached/i.test(diagnostic)) failure = "timeout";
    else failure = "connection";
  } else if (result.status !== "finished") collectionIssue = "invalid-result-status";
  else if (result.tls?.authorized !== true) failure = "tls";
  else if (result.statusCode !== 200) failure = "http";
  else if ((/^\d+\.\d+\.\d+\.\d+$/.test(target) && result.resolvedAddress !== target) ||
    result.truncated !== false || body?.ok !== true || body?.service !== TEST_SERVICE) failure = "wrong-response";
  else if (totalMs === null) collectionIssue = "invalid-timing";
  else if (totalMs > POLICY.accessBudgetMs) failure = "over-budget";
  return { country: probe.country ?? "", city: probe.city ?? "", state: probe.state ?? null,
    asn: probe.asn ?? 0, network: probe.network ?? "",
    latitude: typeof probe.latitude === "number" ? probe.latitude : null, longitude: typeof probe.longitude === "number" ? probe.longitude : null,
    ok: !collectionIssue && !failure, collectionIssue, failure, httpStatus: result.statusCode ?? null,
    tlsAuthorized: result.tls?.authorized === true, ip: result.resolvedAddress ?? null, totalMs,
    failureSource: result.failureSource ?? null, diagnostic: collectionIssue || failure ? diagnostic : "", overBudget: totalMs !== null && totalMs > POLICY.accessBudgetMs };
}

export function summarizeMeasurement(data: any, allocated = data.results?.length): Measurement {
  if (data.status !== "finished" || !Array.isArray(data.results) || !Number.isInteger(allocated) || allocated < 1 || allocated > 9) throw new Error("Measurement is incomplete or invalid");
  const results = data.results.map((row: any) => normalize(row, data.target));
  const counts = (rows: Sample[], field: "failure" | "collectionIssue"): Record<string, number> => {
    const values: Record<string, number> = {}; for (const row of rows) if (row[field]) values[row[field]!] = (values[row[field]!] ?? 0) + 1; return values;
  };
  const carriers = CARRIERS.map(carrier => {
    const rows = results.filter((row: Sample) => row.country === "CN" && row.asn === carrier.asn);
    const successful = rows.filter((row: Sample) => row.ok);
    const issues = rows.filter((row: Sample) => row.collectionIssue).length;
    return { ...carrier, samples: rows.length, successful: successful.length,
      failed: rows.filter((row: Sample) => row.failure).length, collectionIssues: issues,
      successfulP95Ms: p95(successful.map((row: Sample) => row.totalMs!)), failureCounts: counts(rows, "failure") };
  });
  return { measurementId: data.id, reportUrl: `https://api.globalping.io/v1/measurements/${data.id}`, target: data.target, allocated,
    completeCoverage: results.length === allocated && carriers.every(carrier => carrier.samples >= POLICY.probesPerCarrier && !carrier.collectionIssues),
    checked: results.length, successful: results.filter((row: Sample) => row.ok).length,
    failureCounts: counts(results, "failure"), collectionIssueCounts: counts(results, "collectionIssue"), carriers, results };
}

export function focusedSamples<T extends ComparisonSample>(report: { results: T[] }, line: Line): T[] {
  return report.results.filter(row => row.country === "CN" && CARRIERS.some(carrier => carrier.asn === row.asn && (line === "DEFAULT" || carrier.line === line)));
}
function distribution(samples: ComparisonSample[]): string[] {
  // Public metadata describes a cohort, not stable individual probe identities.
  return samples.map(row => JSON.stringify([row.country, row.asn, row.state, row.city, row.network, row.latitude, row.longitude])).sort();
}
export function comparable(reports: ComparisonMeasurement[], line: Line): { ok: boolean; reason: string } {
  if (reports.length !== 3) return { ok: false, reason: "missing-measurement" };
  for (const report of reports) {
    if (report.results.length !== report.allocated || report.results.some(row => row.collectionIssue === "unexpected-probe-location")) return { ok: false, reason: "allocation-or-location-mismatch" };
    const samples = focusedSamples(report, line);
    if (samples.some(row => row.collectionIssue)) return { ok: false, reason: "collection-issue" };
    for (const carrier of CARRIERS.filter(carrier => line === "DEFAULT" || carrier.line === line)) {
      const rows = samples.filter(row => row.asn === carrier.asn);
      if (rows.length < POLICY.probesPerCarrier) return { ok: false, reason: "insufficient-carrier-coverage" };
    }
  }
  const expected = JSON.stringify(distribution(focusedSamples(reports[0], line)));
  if (reports.slice(1).some(report => JSON.stringify(distribution(focusedSamples(report, line))) !== expected)) return { ok: false, reason: "cohort-distribution-changed" };
  return { ok: true, reason: "comparable-public-metadata-no-stable-probe-id" };
}
