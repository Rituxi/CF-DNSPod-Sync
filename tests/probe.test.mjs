import assert from "node:assert/strict";
import test from "node:test";
import testWorker from "../src/test-worker.ts";
import { runRemoteProbe, measurementRequest } from "../src/remote-probe.ts";
import { POLICY } from "../src/config.ts";
import { decideLine } from "../src/selection.ts";
import { StateStore } from "../src/state.ts";
import { now } from "./fixtures.mjs";
import { database, seed, allStates, rawMeasurement, lineState, round } from "./state-fixtures.mjs";
const env = { TARGET_RECORD: "pick.luro.qzz.io", HEALTH_URL: "https://probe.luro.qzz.io/health", PROBE_MODE: "observe" };

test("test service remains fixed/no-store; no forwarding or publicly callable execution endpoint", async () => {
  const response = await testWorker.fetch(new Request(env.HEALTH_URL));
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal((await response.json()).service, "cf-ipv4-test");
  assert.equal((await testWorker.fetch(new Request("https://probe.luro.qzz.io/apply"))).status, 404);
  assert.equal((await testWorker.fetch(new Request(env.HEALTH_URL, { method: "POST" }))).status, 405);
});
test("the supported top-level 10-second timeout preserves HTTPS Host/SNI and reuses the baseline cohort", () => {
  const request = measurementRequest("104.16.0.1", env.HEALTH_URL);
  assert.equal(request.timeout, 10); assert.equal(request.measurementOptions.timeout, undefined);
  assert.equal(request.measurementOptions.request.host, "probe.luro.qzz.io");
  assert.equal(request.measurementOptions.request.path, "/health"); assert.equal(request.locations.length, 3);
  assert.equal(request.measurementOptions.ipVersion, undefined);
  assert.equal(measurementRequest("104.16.0.2", env.HEALTH_URL, { id: "first", count: 9 }).locations, "first");
  assert.throws(() => measurementRequest("104.16.0.1", "https://production.example.com/api/health"), /independent/);
});
async function fixture(options = {}) {
  const d = database(); await seed(d.store, allStates());
  const jobs = new Map(), calls = [];
  let elapsed = 0;
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init }); assert.equal(init.headers?.authorization, undefined);
    if (url.endsWith("/limits")) {
      if (options.limit429) return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      return Response.json({ rateLimit: { measurements: { create: { remaining: options.remaining ?? 250, reset: 3600 } } } });
    }
    assert.ok(url.startsWith("https://api.globalping.io/v1/measurements"), "Probe never calls DNSPod or source websites");
    if (init.method === "POST") {
      if (options.create429 && jobs.size === 1) return new Response(null, { status: 429, headers: { "retry-after": "180" } });
      const request = JSON.parse(init.body); const id = `job${jobs.size + 1}`; jobs.set(id, request);
      return Response.json({ id, probesCount: options.counts ? Object.values(options.counts).reduce((a,b)=>a+b,0) : 9 }, { status: 202 });
    }
    const id = url.split("/").at(-1), request = jobs.get(id);
    if (options.pendingOne && id === "job4") elapsed += options.pollLatencyMs ?? 0;
    await options.onPoll?.({ id, store: new StateStore(d.db) });
    if (options.pending && init.headers?.["if-none-match"]) return new Response(null, { status: 304 });
    const pending = options.pending || (options.pendingOne && id === "job4") || elapsed < (options.pendingUntilMs ?? 0);
    const data = rawMeasurement(request.target, { id, counts: options.counts,
      failures: request.target === lineState().record.Value ? { CU: 1 } : undefined,
      result: options.offline && request.target !== "probe.luro.qzz.io" ? { status: "offline" } : undefined });
    if (options.changedCity && jobs.size > 1 && id === "job3") data.results.find(row => row.probe.asn === 4837).probe.city = "DifferentCity";
    return Response.json({ ...data, status: pending ? "in-progress" : "finished" }, { headers: { etag: '"version1"' } });
  };
  return { d, jobs, calls, fetcher, store: d.store, now: () => now + elapsed,
    sleep: async ms => { elapsed += ms; }, get elapsed() { return elapsed; } };
}
test("a group tests authoritative current IP plus two retained candidates and persists its first results", async () => {
  const f = await fixture();
  try {
    const result = await runRemoteProbe(env, f); assert.equal(result.line, "CU"); assert.equal(result.status, "measured");
    assert.equal(result.reports.length, 4); assert.equal(result.requestedTests, 36); assert.equal(result.dnsWrites, false);
    assert.ok([...f.jobs.values()].slice(1).every(job => job.locations === "job1" && job.limit === 9));
    assert.ok(f.elapsed >= 20_000); assert.ok(result.countedSubrequests <= 50);
    const saved = (await f.store.rounds(now + 60_000))[0];
    assert.equal(saved.reports.find(report => report.target === lineState().record.Value).carriers.find(carrier => carrier.line === "CU").failed, 1);
    const replay = await runRemoteProbe(env, f); assert.equal(replay.reason, "round-already-claimed"); assert.equal(f.jobs.size, 4);
  } finally { f.d.close(); }
});
test("native fetch callbacks are invoked without a class receiver, as required by Workers", async () => {
  const f = await fixture();
  try {
    const result = await runRemoteProbe(env, { ...f, fetcher: async function(url, init) {
      assert.equal(this, undefined); return f.fetcher(url, init);
    } });
    assert.equal(result.status, "measured"); assert.equal(result.reports.length, 4);
  } finally { f.d.close(); }
});
test("missing actual probes, changed cohort and offline probes cannot win", async () => {
  for (const options of [{ counts: { CT: 3, CU: 2, CM: 3 } }, { changedCity: true }, { offline: true }]) {
    const f = await fixture(options);
    try { const result = await runRemoteProbe(env, f); assert.equal(result.status, "partial");
      const state = lineState(); assert.equal(decideLine(state, [round(state, 0, { current: { failures: { CU: 1 } } }), result], now + 60_000).kind, "hold"); }
    finally { f.d.close(); }
  }
});
test("three same-carrier samples are sufficient even if other requested carriers allocate fewer nodes", async () => {
  const f = await fixture({ counts: { CT: 2, CU: 3, CM: 2 } });
  try { const result = await runRemoteProbe(env, f); assert.equal(result.status, "measured"); assert.equal(result.reports[0].completeCoverage, false); }
  finally { f.d.close(); }
});
test("client polling waits for slow jobs, stops within quota, and uses ETags without erasing first failures", async () => {
  const slow = await fixture({ pendingUntilMs: 25_000 });
  try { assert.equal((await runRemoteProbe(env, slow)).reports.length, 4); }
  finally { slow.d.close(); }
  const pending = await fixture({ pending: true });
  try { const result = await runRemoteProbe(env, pending); assert.equal(result.status, "partial"); assert.equal(result.reports.length, 0);
    assert.equal(result.allocations.length, 4); assert.equal(result.errors.length, 4);
    assert.equal(pending.calls.filter(call => call.url.includes("/measurements/")).length, POLICY.maxPollRequests);
    assert.ok(pending.calls.some(call => call.init.headers?.["if-none-match"])); assert.ok(result.countedSubrequests <= 50); }
  finally { pending.d.close(); }
});
test("limits and 429 persist backoff with no tight retries or paid authentication", async () => {
  for (const options of [{ remaining: 40 }, { limit429: true }, { create429: true }]) {
    const f = await fixture(options);
    try {
      const result = await runRemoteProbe(env, f); assert.ok(["held", "partial"].includes(result.status));
      assert.ok((await f.store.control()).backoff_until > now);
      const calls = f.calls.length; const again = await runRemoteProbe(env, f); assert.equal(again.reason, "provider-backoff"); assert.equal(f.calls.length, calls);
      if (options.create429) assert.equal(f.calls.filter(call => call.init.method === "POST").length, 2);
    } finally { f.d.close(); }
  }
});
test("frozen publishing does not stop measurement; missing/stale authority prevents measuring cached DNS as current", async () => {
  assert.equal((await runRemoteProbe({ ...env, PROBE_MODE: "paused" }, { fetcher: () => { assert.fail("Paused probe must remain offline"); } })).status, "paused");
  const f = await fixture();
  try { await f.store.freeze(true, now); assert.equal((await runRemoteProbe(env, f)).reports.length, 4); }
  finally { f.d.close(); }
  const stale = await fixture();
  try { await stale.store.saveLines(allStates().map(state => ({ ...state, fetchedAt: now - POLICY.snapshotMaxAgeMs - 1 })), now);
    const result = await runRemoteProbe(env, stale); assert.equal(result.reason, "authoritative-snapshot-missing-or-stale"); assert.equal(stale.calls.length, 0); }
  finally { stale.d.close(); }
});
test("completed first failures are persisted while a slow final job is bounded by the lease deadline", async () => {
  let sawPersistedFirstFailure = false;
  const f = await fixture({ pendingOne: true, pollLatencyMs: 8000, onPoll: async ({ id, store }) => {
    if (id !== "job4") return;
    const saved = (await store.rounds(now + POLICY.leaseMs))[0];
    if (saved?.reports.length) {
      const current = saved.reports.find(report => report.target === lineState().record.Value);
      assert.equal(current.carriers.find(carrier => carrier.line === "CU").failed, 1);
      sawPersistedFirstFailure = true;
    }
  } });
  try {
    const result = await runRemoteProbe(env, f);
    assert.equal(result.status, "partial"); assert.ok(sawPersistedFirstFailure);
    assert.ok(f.elapsed < POLICY.leaseMs); assert.ok(result.countedSubrequests <= 50);
    const saved = (await f.store.rounds(now + POLICY.leaseMs))[0];
    assert.equal(saved.status, "partial"); assert.equal(saved.reports.length, 3);
    assert.equal(saved.reports.find(report => report.target === lineState().record.Value).carriers.find(carrier => carrier.line === "CU").failed, 1);
    assert.ok(f.calls.filter(call => call.url.includes("/measurements/")).length <= POLICY.maxPollRequests);
  } finally { f.d.close(); }
});
test("one degradation recheck leaves the regular rotation cursor fair and shares the slot budget", async () => {
  const f = await fixture();
  try {
    // First CU round has a confirmed majority failure and is followed by one priority CU round.
    const initial = f.fetcher;
    f.fetcher = async (url, init) => {
      const response = await initial(url, init);
      if (!url.includes("/measurements/") || init?.method === "POST") return response;
      const body = await response.json();
      if (body.target === lineState().record.Value) {
        const raw = rawMeasurement(body.target, { id: body.id, failures: { CU: 2 } });
        return Response.json(raw);
      }
      return Response.json(body);
    };
    const first = await runRemoteProbe(env, f); assert.equal(first.line, "CU");
    assert.equal((await f.store.control()).priority_line, "CU");
    let at = now + POLICY.slotMs;
    const second = await runRemoteProbe(env, { ...f, now: () => at }); assert.equal(second.line, "CU");
    assert.equal((await f.store.control()).priority_line, null);
    at += POLICY.slotMs;
    const third = await runRemoteProbe(env, { ...f, now: () => at }); assert.equal(third.line, "CT");
    assert.equal((await f.store.control()).probe_cursor, 2);
  } finally { f.d.close(); }
});
