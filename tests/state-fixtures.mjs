import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { StateStore } from "../src/state.ts";
import { summarizeMeasurement, CARRIERS } from "../src/measurement.ts";
import { POLICY, LINES } from "../src/config.ts";
import { candidate, record, now } from "./fixtures.mjs";

export function database(filename = ":memory:", initialize = true) {
  const connection = new DatabaseSync(filename);
  if (initialize) for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")).sort()) {
    connection.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const db = { prepare(sql) {
    const query = connection.prepare(sql);
    return { values: [], bind(...values) { this.values = values; return this; },
      async all() { const results = query.all(...this.values); return { results, success: true }; },
      async run() { const result = query.run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; } };
  }, async batch(statements) {
    connection.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.all()); connection.exec("COMMIT"); return results; }
    catch (error) { connection.exec("ROLLBACK"); throw error; }
  } };
  return { db, connection, store: new StateStore(db), close: () => connection.close() };
}
export function lineState(line = "CU", extra = {}) {
  const index = LINES.findIndex(item => item.id === line);
  return { line, name: LINES[index].name, version: `version-${line}`, record: record(index), fetchedAt: now,
    lastSwitchAt: now - 2 * 3600_000, sourceHealthy: true, backups: [],
    candidates: [0, 1].map(offset => ({ ...candidate(line, { ip: `104.16.0.${20 + index + offset * 10}`, rank: offset + 1 }), expiresAt: now + 5 * 3600_000 })), ...extra };
}
export const allStates = () => LINES.map(line => lineState(line.id));
export function rawMeasurement(target, options = {}) {
  const results = CARRIERS.flatMap(carrier => Array.from({ length: options.counts?.[carrier.line] ?? 3 }, (_, index) => {
    const failed = index < (options.failures?.[carrier.line] ?? 0);
    return { probe: { country: "CN", state: ["Beijing", "Shanghai", "Guangdong"][index], city: ["Beijing", "Shanghai", "Guangzhou"][index],
      asn: carrier.asn, network: `carrier-${carrier.asn}`, latitude: 20 + index, longitude: 110 + index },
      result: { status: failed ? "failed" : "finished", ...(failed ? { failureSource: "target" } : {}),
        rawOutput: failed ? "curl: (7) Failed to connect to host" : "HTTP/2 200", statusCode: failed ? undefined : 200,
        tls: { authorized: true }, truncated: false, rawBody: '{"ok":true,"service":"cf-ipv4-test"}',
        resolvedAddress: target === "probe.luro.qzz.io" ? "104.16.0.90" : target,
        timings: { total: options.latency ?? 500 }, ...options.result } };
  }));
  return { id: options.id ?? "measurement", target, status: "finished", results };
}
export const measurement = (target, options = {}) => summarizeMeasurement(rawMeasurement(target, options), options.allocated ?? 9);
export function round(state, index = 0, options = {}) {
  const startedAt = options.startedAt ?? now - (2 - index) * POLICY.slotMs;
  return { id: `round-${state.line}-${index}`, slot: Math.floor(startedAt / POLICY.slotMs), line: state.line,
    baselineVersion: state.version, currentIp: state.record.Value, startedAt, completedAt: startedAt + 30_000,
    status: "measured", candidates: structuredClone(state.candidates), allocations: [], requestedTests: 36, errors: [],
    reports: [measurement("probe.luro.qzz.io"), measurement(state.record.Value, options.current),
      ...state.candidates.map(candidate => measurement(candidate.ip, options.challenger))], ...options.round };
}
export async function seed(store, states = allStates(), rounds = [], frozen = false) {
  await store.freeze(frozen, now); await store.saveLines(states, now);
  for (const item of rounds) { await store.startRound(item, 36); await store.saveRound(item); }
}
