import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { signRequest, DnsPod } from "../src/dnspod.ts";
import { synchronize, managedRecords } from "../src/sync.ts";
import { POLICY } from "../src/config.ts";
import { env, now, record, transition, dnsLines, fixture } from "./fixtures.mjs";
import { database, seed, lineState, allStates, round } from "./state-fixtures.mjs";

test("Web Crypto TC3 agrees with Node crypto across a UTC day boundary", async () => {
  const stamp = Math.floor(Date.parse("2026-10-25T00:05:00+08:00") / 1000), payload = '{"Domain":"pick.luro.qzz.io"}';
  const hash = value => createHash("sha256").update(value).digest("hex"), mac = (key, value) => createHmac("sha256", key).update(value).digest();
  const scope = "2026-10-24/dnspod/tc3_request";
  const canonical = ["POST", "/", "", "content-type:application/json; charset=utf-8\nhost:dnspod.tencentcloudapi.com\n", "content-type;host", hash(payload)].join("\n");
  const expected = mac(mac(mac(mac("TC3test-key", "2026-10-24"), "dnspod"), "tc3_request"), `TC3-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`).toString("hex");
  assert.ok((await signRequest("test-id", "test-key", "DescribeDomain", payload, stamp)).authorization.endsWith(expected));
});
test("a reused DNSPod client signs correctly before and after UTC midnight", async () => {
  let at = Date.parse("2026-10-25T23:59:59Z");
  const hash = value => createHash("sha256").update(value).digest("hex"), mac = (key, value) => createHmac("sha256", key).update(value).digest();
  const client = new DnsPod({ ...env, TENCENTCLOUD_SECRET_ID: "test-id", TENCENTCLOUD_SECRET_KEY: "test-key" }, async (url, init) => {
    const stamp = Number(init.headers["x-tc-timestamp"]), date = new Date(stamp * 1000).toISOString().slice(0, 10);
    const scope = `${date}/dnspod/tc3_request`;
    const canonical = ["POST", "/", "", "content-type:application/json; charset=utf-8\nhost:dnspod.tencentcloudapi.com\n", "content-type;host", hash(init.body)].join("\n");
    const expected = mac(mac(mac(mac("TC3test-key", date), "dnspod"), "tc3_request"), `TC3-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`).toString("hex");
    assert.ok(init.headers.authorization.endsWith(expected));
    return Response.json({ Response: { RequestId: "test" } });
  }, () => at);
  await client.call("DescribeDomain"); await client.call("DescribeDomain");
  at += 2000; await client.call("DescribeDomain");
});
test("DNSPod record types, real line IDs, ownership and TTL are checked; no legacy CNAME migration", () => {
  assert.equal(managedRecords([0, 1, 2, 3].map(i => record(i)), dnsLines).length, 4);
  for (const invalid of [transition(), record(0, { Type: "AAAA" }), record(0, { Remark: "someone-else" }), record(0, { TTL: 300 }), record(0, { Line: "联通" })]) {
    assert.throws(() => managedRecords([invalid, record(1), record(2), record(3)], dnsLines));
  }
  assert.throws(() => managedRecords([0, 1, 2, 3].map(i => record(i)).concat(record(0, { RecordId: 900 })), dnsLines));
});
async function setup(options = {}) {
  const d = database(), states = allStates();
  const selected = states.find(state => state.line === "CU");
  const rounds = options.allLines ? states.flatMap(state => [0, 1].map(index => round(state, index, { current: { failures: { [state.line === "DEFAULT" ? "CT" : state.line]: 1 } } }))) :
    options.winner === false ? [] : [0, 1].map(index => round(selected, index, { current: { failures: { CU: 1 } } }));
  if (options.secondLine) {
    const ct = states.find(state => state.line === "CT");
    rounds.push(...[0, 1].map(index => round(ct, index, { current: { failures: { CT: 1 } } })));
  }
  await seed(d.store, states, rounds, options.frozen ?? false);
  const rows = states.flatMap(state => state.candidates);
  const f = fixture({ ...options, rows });
  return { d, states, f, options: { fetcher: f.fetcher, store: d.store, now, sleep: async () => {} } };
}
test("measured mode holds without evidence even when the feed leader changes", async () => {
  const t = await setup({ winner: false });
  try { const result = await synchronize(env, t.options); assert.equal(result.status, "held"); assert.equal(t.f.writeCount, 0); assert.ok(result.decisions.every(decision => decision.reason === "need-two-distinct-rounds")); }
  finally { t.d.close(); }
});
test("plan is read-only in DNS and state; cloud and CLI share the same measured decision", async () => {
  const t = await setup();
  try {
    const before = JSON.stringify(await t.d.store.lines());
    const snapshot = () => JSON.stringify(["tool_control", "line_state", "probe_rounds", "switch_history"].map(table =>
      t.d.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const allBefore = snapshot();
    const planned = await synchronize(env, { ...t.options, dryRun: true });
    assert.equal(planned.decisions.find(row => row.line === "CU").kind, "switch"); assert.equal(t.f.writeCount, 0);
    assert.equal(JSON.stringify(await t.d.store.lines()), before);
    assert.equal(snapshot(), allBefore);
    let saved = false;
    const result = await synchronize(env, { ...t.options, beforeApply: async plan => { assert.equal(t.f.writeCount, 0); assert.equal(plan.decisions.find(row => row.line === "CU").ip, planned.decisions.find(row => row.line === "CU").ip); saved = true; } });
    assert.equal(result.status, "updated"); assert.ok(saved); assert.equal(t.f.writeCount, 1); assert.ok(result.countedSubrequests <= 50);
    assert.ok(!t.f.calls.some(call => ["CreateRecord", "DeleteRecord", "ModifyRecordRemark"].includes(call.action)));
    const again = await synchronize(env, t.options); assert.equal(again.status, "held"); assert.equal(t.f.writeCount, 1);
  } finally { t.d.close(); }
});
test("freeze and observe keep collecting snapshots but never write; explicit ranking fallback cannot bypass freeze", async () => {
  const t = await setup({ frozen: true });
  try {
    assert.equal((await synchronize(env, { ...t.options, manualRankedLine: "CU" })).dnsWrites, false);
    await t.d.store.freeze(false, now);
    assert.equal((await synchronize({ ...env, SYNC_MODE: "observe" }, t.options)).dnsWrites, false);
    assert.equal((await t.d.store.lines()).length, 4); assert.equal(t.f.writeCount, 0);
  } finally { t.d.close(); }
  const paused = await synchronize({ ...env, SYNC_MODE: "paused" }, { fetcher: () => { throw new Error("must stay offline"); } });
  assert.equal(paused.status, "paused");
});
test("an authoritative change before publication invalidates evidence and performs no DNS write", async () => {
  const t = await setup({ preflightChange: true });
  try { const result = await synchronize(env, t.options); assert.equal(t.f.writeCount, 0); assert.equal(result.outcomes.find(row => row.line === "CU").reason, "authoritative-baseline-changed"); }
  finally { t.d.close(); }
});

test("Actions frozen validation cannot publish if the freeze has been released", async () => {
  const t = await setup({ frozen: false });
  try {
    const before = JSON.stringify(await t.d.store.lines());
    await assert.rejects(synchronize(env, { ...t.options, requireFrozen: true }), /requires publication to remain frozen/);
    assert.equal(t.f.writeCount, 0);
    assert.equal(JSON.stringify(await t.d.store.lines()), before);
    assert.equal((await t.d.store.control()).sync_owner, null);
    await t.d.store.freeze(true, now);
    const result = await synchronize(env, { ...t.options, requireFrozen: true });
    assert.equal(result.frozen, true); assert.equal(result.dnsWrites, false);
    assert.equal(result.outcomes.find(outcome => outcome.line === "CU").reason, "publication-frozen");
  } finally { t.d.close(); }
});
test("provider refusal is per-line failure; another independently qualified line can still update", async () => {
  const t = await setup({ secondLine: true, rejectAction: "ModifyRecord", rejectLine: "联通" });
  try {
    const result = await synchronize(env, t.options); assert.equal(result.status, "partial");
    assert.equal(result.outcomes.find(row => row.line === "CU").status, "failed");
    assert.equal(result.outcomes.find(row => row.line === "CT").status, "updated");
    assert.ok(!JSON.stringify(result).includes("secret-must-not-appear")); assert.ok(result.countedSubrequests <= 50);
  } finally { t.d.close(); }
});
test("read-back mismatch remains unverified and a replay cannot repeat the same write", async () => {
  const t = await setup({ badReadback: true });
  try {
    const result = await synchronize(env, t.options); assert.equal(result.status, "partial"); assert.equal(t.f.writeCount, 1);
    assert.equal(t.f.calls.filter(call => call.action === "DescribeRecord").length, 4);
    assert.equal(t.d.connection.prepare("SELECT status FROM switch_history").get().status, "failed-or-unverified");
    await synchronize(env, t.options); assert.equal(t.f.writeCount, 1);
  } finally { t.d.close(); }
});
test("source/range outages keep current records even with old winning evidence", async () => {
  for (const failure of [{ sourceFailure: true }, { rangeFailure: true }]) {
    const t = await setup(failure);
    try { const result = await synchronize(env, t.options); assert.equal(result.status, "held"); assert.equal(t.f.writeCount, 0); }
    finally { t.d.close(); }
  }
});
test("all four qualifying changes plus two delayed read-backs each remain within 50 combined subrequests", async () => {
  const t = await setup({ allLines: true, readBackFailures: 2 });
  try {
    const result = await synchronize(env, t.options);
    assert.equal(result.outcomes.filter(row => row.status === "updated").length, 4);
    assert.equal(t.f.writeCount, 4);
    assert.ok(result.countedSubrequests <= 50, `actual ${result.countedSubrequests}`);
  } finally { t.d.close(); }
});
test("missing tool state and missing DNS permissions fail without falling back to rankings", async () => {
  await assert.rejects(synchronize(env), /dedicated tool STATE/);
  const t = await setup({ rejectAction: "DescribeRecordList" });
  try { await assert.rejects(synchronize(env, t.options), /UnauthorizedOperation/); assert.equal(t.f.writeCount, 0); }
  finally { t.d.close(); }
});
test("wrong authority, missing lines and truncated record lists stop before any DNS write", async () => {
  for (const options of [{ wrongDomain: true }, { lines: dnsLines.slice(0, 3) }, { truncated: true }]) {
    const t = await setup(options);
    try { await assert.rejects(synchronize(env, t.options)); assert.equal(t.f.writeCount, 0); }
    finally { t.d.close(); }
  }
});
test("publication preserves unrelated NS/TXT records and only modifies the qualified managed A", async () => {
  const other = [record(0, { RecordId: 900, Type: "NS", Value: "f1g1ns1.dnspod.net." }), record(0, { RecordId: 901, Type: "TXT", Value: "keep" })];
  const t = await setup({ records: [0, 1, 2, 3].map(i => record(i)).concat(other) });
  try {
    await synchronize(env, t.options);
    assert.deepEqual(t.f.records.filter(row => row.RecordId >= 900), other);
    assert.deepEqual(t.f.calls.filter(call => call.action === "ModifyRecord").map(call => call.body.RecordId), [record(2).RecordId]);
  } finally { t.d.close(); }
});
test("API adapter still rejects another zone and deletion actions", async () => {
  const f = fixture(), client = new DnsPod(env, f.fetcher);
  await assert.rejects(client.call("DeleteRecord", { RecordId: 1 }), /scope/);
  await assert.rejects(client.call("DescribeDomain", { Domain: "elsewhere.com" }), /overridden/);
  await assert.rejects(client.call("CreateRecord", { SubDomain: "www", RecordType: "A", RecordLine: "默认", TTL: 600 }), /scope|four/);
  assert.throws(() => new DnsPod({ ...env, DNSPOD_DOMAIN: "production.example.com" }), /dedicated/);
});
test("freezing immediately before publication creates no poisoned attempt and resume can use valid evidence", async () => {
  const t = await setup();
  try {
    const result = await synchronize(env, { ...t.options, beforeApply: () => t.d.store.freeze(true, now) });
    assert.equal(result.dnsWrites, false); assert.equal(t.f.writeCount, 0);
    assert.equal(t.d.connection.prepare("SELECT COUNT(*) n FROM switch_history").get().n, 0);
    await t.d.store.freeze(false, now);
    const resumed = await synchronize(env, t.options);
    assert.equal(resumed.outcomes.find(row => row.line === "CU").status, "updated"); assert.equal(t.f.writeCount, 1);
  } finally { t.d.close(); }
});
test("losing the sync lease before publication cannot write DNS or release a successor's lease", async () => {
  const t = await setup(); let successor;
  try {
    await synchronize(env, { ...t.options, beforeApply: async () => { successor = await t.d.store.claimSync(now + POLICY.leaseMs + 1); } });
    assert.ok(successor); assert.equal(t.f.writeCount, 0);
    assert.equal((await t.d.store.control()).sync_owner, successor);
  } finally { t.d.close(); }
});
test("candidates and two-round evidence are rechecked at publication time after asynchronous work", async () => {
  for (const expiry of ["candidate", "evidence"]) {
    const t = await setup(); let at = now;
    try {
      if (expiry === "candidate") {
        // Refreshing from the source retains this actual measurement timestamp.
        const states = t.states.map(state => ({ ...state, candidates: state.candidates.map(item => ({ ...item,
          measuredAt: now - POLICY.evidenceMaxAgeMs + 1000, expiresAt: now + 1000 })) }));
        await t.d.store.saveLines(states, now);
        const f = fixture({ rows: states.flatMap(state => state.candidates) }); t.options.fetcher = f.fetcher;
        t.checkedFixture = f;
      } else {
        const state = t.states.find(state => state.line === "CU");
        const oldest = round(state, 0, { startedAt: now - POLICY.evidenceMaxAgeMs + 1000, current: { failures: { CU: 1 } } });
        t.d.connection.prepare("DELETE FROM probe_rounds WHERE id=?").run(oldest.id);
        await t.d.store.startRound(oldest, 36);
      }
      const result = await synchronize(env, { ...t.options, now: () => at, beforeApply: async () => { at += 1500; } });
      assert.equal((t.checkedFixture ?? t.f).writeCount, 0, expiry);
      assert.equal(result.outcomes.find(row => row.line === "CU").reason, "evidence-expired-before-write");
    } finally { t.d.close(); }
  }
});
test("an uncertain publication rebuilds its baseline and can recover with fresh evidence without blind replay", async () => {
  const t = await setup();
  try {
    let sent = 0;
    const lostResponse = async (url, init) => {
      if (init?.headers?.["x-tc-action"] === "ModifyRecord") { sent++; throw new Error("Response lost before acceptance could be established"); }
      return t.f.fetcher(url, init);
    };
    const failed = await synchronize(env, { ...t.options, fetcher: lostResponse });
    assert.equal(failed.status, "partial"); assert.equal(failed.dnsWrites, true); assert.equal(sent, 1);
    const oldVersion = (await t.d.store.lines()).find(state => state.line === "CU").version;
    const preview = await synchronize(env, { ...t.options, dryRun: true });
    assert.equal(preview.decisions.find(row => row.line === "CU").kind, "hold");
    assert.equal((await t.d.store.lines()).find(state => state.line === "CU").version, oldVersion);
    await synchronize(env, t.options); assert.equal(t.f.writeCount, 0);
    const state = (await t.d.store.lines()).find(state => state.line === "CU"); assert.notEqual(state.version, oldVersion);
    const later = now + 2 * 3600_000;
    for (const index of [2, 3]) {
      const item = round(state, index, { startedAt: later - (4 - index) * POLICY.slotMs, current: { failures: { CU: 1 } } });
      await t.d.store.startRound(item, 36);
      await t.d.store.saveRound(item);
    }
    const recovered = await synchronize(env, { ...t.options, now: later });
    assert.equal(recovered.outcomes.find(row => row.line === "CU").status, "updated"); assert.equal(t.f.writeCount, 1);
  } finally { t.d.close(); }
});
test("a crashed publication intent also invalidates old evidence after the lease expires", async () => {
  const t = await setup();
  try {
    const state = t.states.find(state => state.line === "CU"), owner = await t.d.store.claimSync(now);
    await t.d.store.beginSwitch(`CU:${state.version}:old-evidence:${state.candidates[0].ip}`, "CU", now, {}, owner);
    const result = await synchronize(env, { ...t.options, now: now + POLICY.leaseMs + 1 });
    assert.equal(t.f.writeCount, 0); assert.equal(result.decisions.find(row => row.line === "CU").kind, "hold");
    assert.notEqual((await t.d.store.lines()).find(row => row.line === "CU").version, state.version);
  } finally { t.d.close(); }
});
test("a newer adverse, partial or running probe round arriving during sync prevents stale publication", async () => {
  for (const status of ["measured", "partial", "running", "future-running"]) {
    const t = await setup(); let at = now;
    try {
      const state = t.states.find(state => state.line === "CU");
      const result = await synchronize(env, { ...t.options, now: () => at, beforeApply: async () => {
        at += 1000;
        const running = status.endsWith("running");
        const item = round(state, 2, { startedAt: at + (status === "future-running" ? 60_000 : 0), current: { failures: { CU: 0 } }, challenger: { failures: { CU: 3 } },
          round: { status: running ? "running" : status, completedAt: running ? undefined : at } });
        await t.d.store.startRound(item, 36);
        await t.d.store.saveRound(item);
      } });
      assert.equal(t.f.writeCount, 0, status);
      assert.equal(result.outcomes.find(row => row.line === "CU").status, "held");
      assert.equal(t.d.connection.prepare("SELECT COUNT(*) n FROM switch_history").get().n, 0);
    } finally { t.d.close(); }
  }
});
test("a captured winning round becoming partial before publication invalidates its evidence", async () => {
  const t = await setup();
  try {
    await synchronize(env, { ...t.options, beforeApply: async () => {
      const item = (await t.d.store.latestRounds(now)).find(item => item.line === "CU");
      item.status = "partial"; item.errors.push({ target: "measurement-system", error: "Final persistence interrupted" });
      await t.d.store.saveRound(item);
    } });
    assert.equal(t.f.writeCount, 0);
    assert.equal(t.d.connection.prepare("SELECT COUNT(*) n FROM switch_history").get().n, 0);
  } finally { t.d.close(); }
});
test("new measurements on another line do not invalidate an unchanged two-round decision", async () => {
  const t = await setup(); let at = now;
  try {
    const result = await synchronize(env, { ...t.options, now: () => at, beforeApply: async () => {
      at += 1000;
      const state = t.states.find(state => state.line === "CT");
      const item = round(state, 2, { startedAt: at, round: { status: "partial", completedAt: at } });
      await t.d.store.startRound(item, 36); await t.d.store.saveRound(item);
    } });
    assert.equal(t.f.writeCount, 1); assert.equal(result.outcomes.find(row => row.line === "CU").status, "updated");
  } finally { t.d.close(); }
});
