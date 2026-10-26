import assert from "node:assert/strict";
import test from "node:test";
import { decideLine, compareRound } from "../src/selection.ts";
import { buildChallengers } from "../src/candidates.ts";
import { summarizeMeasurement, comparable } from "../src/measurement.ts";
import { POLICY } from "../src/config.ts";
import { now, candidate } from "./fixtures.mjs";
import { lineState, round, rawMeasurement } from "./state-fixtures.mjs";

test("current IP survives falling out of rankings; challengers stay across changing rankings and expire by measurement time", () => {
  const state = lineState();
  const pool = { candidates: [candidate("CU", { ip: "104.16.0.40", rank: 1 }), candidate("CU", { ip: "104.16.0.41", rank: 2 }), candidate("CU", { ip: "104.16.0.42", rank: 3 }), candidate("CU", { ip: "104.16.0.43", rank: 4 })] };
  assert.deepEqual(buildChallengers("CU", state.record.Value, pool, state.candidates, now).map(row => row.ip), state.candidates.map(row => row.ip));
  assert.deepEqual(buildChallengers("CU", state.record.Value, pool, [], now).map(row => row.ip), ["104.16.0.40", "104.16.0.41"]);
  const expired = state.candidates.map(row => ({ ...row, expiresAt: now - 1 }));
  assert.equal(buildChallengers("CU", state.record.Value, { candidates: [] }, expired, now).length, 0);
});
test("HostMonit fills missing positions while stale/default-mismatched candidates cannot be invented", () => {
  const pool = { candidates: [candidate("CU", { ip: "104.16.0.40" }), candidate("CU", { ip: "104.16.0.41", source: "hostmonit" }), candidate("CT", { source: "hostmonit" })] };
  assert.deepEqual(buildChallengers("CU", "104.16.0.3", pool, [], now).map(row => row.source), ["v2rayssr", "hostmonit"]);
  assert.deepEqual(buildChallengers("DEFAULT", "104.16.0.1", pool, [], now), []);
});
test("new bad reports invalidate retained candidates without extending their measurement timestamp", () => {
  const state = lineState();
  const pool = { candidates: [], rejectedCandidates: state.candidates.map(row => ({ ...row, measuredAt: now, reason: "loss" })) };
  assert.deepEqual(buildChallengers("CU", state.record.Value, pool, state.candidates, now), []);
});
test("a newer bad report cannot be bypassed by an older shortlist entry from another source", () => {
  const state = lineState(), item = state.candidates[0];
  const pool = { candidates: [{ ...item, source: "hostmonit", measuredAt: now - 120_000 }],
    rejectedCandidates: [{ ...item, measuredAt: now, reason: "loss" }] };
  assert.deepEqual(buildChallengers("CU", state.record.Value, pool, [item], now), []);
  pool.candidates[0].measuredAt = now + 1000;
  assert.deepEqual(buildChallengers("CU", state.record.Value, pool, [item], now).map(row => row.ip), [item.ip]);
});
test("a retained candidate refreshes newer good evidence before considering an intermediate bad report", () => {
  const state = lineState(), item = state.candidates[0];
  const pool = { candidates: [1, 2, 3].map(rank => candidate("CU", { ip: `104.16.0.${50 + rank}`, rank })),
    rejectedCandidates: [{ ...item, measuredAt: now - 1000, reason: "loss" }] };
  pool.candidates.push({ ...item, measuredAt: now, rank: 4 });
  const result = buildChallengers("CU", state.record.Value, pool, [item], now);
  assert.equal(result[0].ip, item.ip); assert.equal(result[0].measuredAt, now);
});
test("14.8-second HTTP 200 is over budget; certificate, body and HTTP errors remain failures", () => {
  for (const [result, failure] of [[{ timings: { total: 14800 } }, "over-budget"], [{ statusCode: 403 }, "http"],
    [{ tls: { authorized: false } }, "tls"], [{ rawBody: '{"ok":true,"service":"wrong"}' }, "wrong-response"],
    [{ rawBody: "<html>错误页面</html>" }, "wrong-response"], [{ truncated: true }, "wrong-response"],
    [{ resolvedAddress: "104.16.0.21" }, "wrong-response"]]) {
    const report = summarizeMeasurement(rawMeasurement("104.16.0.20", { result }), 9);
    assert.equal(report.successful, 0); assert.ok(report.results.every(row => row.failure === failure));
  }
  assert.equal(summarizeMeasurement(rawMeasurement("104.16.0.20", { latency: 10000 }), 9).successful, 9);
  const missingTiming = summarizeMeasurement(rawMeasurement("104.16.0.20", { result: { timings: { total: null } } }), 9);
  assert.equal(missingTiming.successful, 0); assert.ok(missingTiming.results.every(row => row.collectionIssue === "invalid-timing"));
});
test("DNS, explicit timeout, connection and provider/offline failures have separate categories", () => {
  for (const [result, failure, issue] of [
    [{ status: "failed", failureSource: "resolver" }, "dns", null],
    [{ status: "failed", failureSource: "target", rawOutput: "curl: (28) Operation timed out" }, "timeout", null],
    [{ status: "failed", failureSource: "target", rawOutput: "Request timed out during the TLS handshake." }, "timeout", null],
    [{ status: "failed", failureSource: "target", rawOutput: "connection refused" }, "connection", null],
    [{ status: "offline" }, null, "probe-offline"], [{ status: "failed", failureSource: "internal" }, null, "provider-internal"],
  ]) { const rows = summarizeMeasurement(rawMeasurement("104.16.0.20", { result }), 9).results;
    assert.ok(rows.every(row => row.failure === failure && row.collectionIssue === issue)); }
});
test("only two complete same-baseline rounds with fewer failures switch", () => {
  const state = lineState();
  const rounds = [0, 1].map(index => round(state, index, { current: { failures: { CU: 1 } } }));
  assert.equal(decideLine(state, rounds.slice(0, 1), now).kind, "hold");
  const decision = decideLine(state, rounds, now);
  assert.equal(decision.kind, "switch"); assert.equal(decision.reason, "fewer-failures-two-rounds"); assert.equal(decision.evidence.length, 2);
});
test("ties hold, faster with more failures loses, and speed requires both absolute and relative improvements", () => {
  const state = lineState();
  for (const options of [
    { current: { latency: 500 }, challenger: { latency: 450 } },
    { current: { failures: { CU: 1 }, latency: 1000 }, challenger: { failures: { CU: 1 }, latency: 100 } },
    { current: { latency: 1000 }, challenger: { failures: { CU: 1 }, latency: 100 } },
    { current: { latency: 100 }, challenger: { latency: 50 } },
  ]) assert.equal(decideLine(state, [0, 1].map(index => round(state, index, options)), now).kind, "hold");
  const winner = decideLine(state, [0, 1].map(index => round(state, index, { current: { latency: 500 }, challenger: { latency: 350 } })), now);
  assert.equal(winner.reason, "faster-zero-failure-two-rounds");
});
test("default cannot increase one carrier's failures even when total failures decline", () => {
  const state = lineState("DEFAULT");
  const rounds = [0, 1].map(index => round(state, index, { current: { failures: { CT: 2 } }, challenger: { failures: { CU: 1 } } }));
  assert.equal(decideLine(state, rounds, now).kind, "hold");
});
test("operator decision ignores off-operator network failures but keeps all own-carrier failures", () => {
  const state = lineState();
  const rounds = [0, 1].map(index => round(state, index, { current: { failures: { CU: 1 } }, challenger: { failures: { CT: 3, CM: 3 } } }));
  const decision = decideLine(state, rounds, now);
  assert.equal(decision.kind, "switch"); assert.equal(decision.comparisons[0].samples, 3); assert.equal(decision.comparisons[0].currentFailed, 1);
});
test("candidate ordering prioritizes failures across both rounds before speed", () => {
  const state = lineState(), [fast, reliable] = state.candidates;
  const rounds = [0, 1].map(index => round(state, index, { current: { failures: { CU: 3 } } }));
  rounds[0].reports[2] = summarizeMeasurement(rawMeasurement(fast.ip, { latency: 100, failures: { CU: 2 } }), 9);
  rounds[0].reports[3] = summarizeMeasurement(rawMeasurement(reliable.ip, { latency: 500, failures: { CU: 1 } }), 9);
  rounds[1].reports[2] = summarizeMeasurement(rawMeasurement(fast.ip, { latency: 100 }), 9);
  assert.equal(decideLine(state, rounds, now).ip, reliable.ip);
});
test("cooldown holds normal changes; two majority failures permit a freshly verified zero-failure backup", () => {
  const state = lineState("CU", { lastSwitchAt: now - 15 * 60_000 });
  const normal = [0, 1].map(index => round(state, index, { current: { failures: { CU: 1 } } }));
  assert.equal(decideLine(state, normal, now).reason, "cooldown-60-minutes");
  const emergency = [0, 1].map(index => round(state, index, { current: { failures: { CU: 2 } } }));
  const decision = decideLine(state, emergency, now);
  assert.equal(decision.kind, "switch"); assert.equal(decision.emergency, true); assert.equal(decision.backups.length, 2);
  const old = emergency.map(item => ({ ...item, startedAt: item.startedAt - 3 * 3600_000, completedAt: item.completedAt - 3 * 3600_000 }));
  assert.equal(decideLine(state, old, now).reason, "cooldown-60-minutes");
});
test("expired evidence, stale snapshots/sources and changed version cannot switch", () => {
  const state = lineState(), rounds = [0, 1].map(index => round(state, index, { current: { failures: { CU: 1 } } }));
  assert.equal(decideLine({ ...state, version: "new-version" }, rounds, now).kind, "hold");
  assert.equal(decideLine({ ...state, sourceHealthy: false }, rounds, now).reason, "source-unavailable-hold-current");
  assert.equal(decideLine({ ...state, fetchedAt: now - POLICY.snapshotMaxAgeMs - 1 }, rounds, now).kind, "hold");
  assert.equal(decideLine(state, rounds.map(item => ({ ...item, startedAt: now - POLICY.evidenceMaxAgeMs - 1 })), now).kind, "hold");
});
test("duplicate round IDs or two IDs in one slot never count as two wins", () => {
  const state = lineState(), first = round(state, 0, { current: { failures: { CU: 1 } } });
  assert.equal(decideLine(state, [first, structuredClone(first)], now).kind, "hold");
  assert.equal(decideLine(state, [first, { ...first, id: "another-id" }], now).kind, "hold");
});
test("insufficient probes, swapped locations, offline results and pending rounds break a streak", () => {
  const state = lineState(), first = round(state, 0, { current: { failures: { CU: 1 } } });
  for (const options of [{ challenger: { counts: { CU: 2 } } }, { challenger: { result: { status: "offline" } } }, { round: { reports: [], status: "running", completedAt: undefined } }]) {
    assert.equal(decideLine(state, [first, round(state, 1, options)], now).kind, "hold");
  }
  const changed = round(state, 1, { current: { failures: { CU: 1 } } });
  changed.reports[2].results.find(row => row.asn === 4837).city = "AnotherCity";
  assert.equal(compareRound(changed, "CU", state.candidates[0].ip).eligible, false);
  const good = round(state, 1, { current: { failures: { CU: 1 } } });
  assert.equal(compareRound(good, "CU", state.candidates[0].ip).currentFailed, 1);
});
