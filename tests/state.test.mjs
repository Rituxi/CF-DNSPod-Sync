import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { StateStore } from "../src/state.ts";
import { POLICY } from "../src/config.ts";
import { now } from "./fixtures.mjs";
import { database, seed, allStates, lineState, round } from "./state-fixtures.mjs";
import { remoteState } from "../scripts/runtime.mjs";
import { decideLine } from "../src/selection.ts";

const cliScope = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111" };
const cliConfig = { database: { accountId: cliScope.accountId, name: "cf-dnspod-state", id: cliScope.databaseId } };

async function publicationEvidence(store) {
  const state = lineState(), rounds = [0, 1].map(index => round(state, index));
  await seed(store, allStates(), rounds);
  return { roundIds: rounds.reverse().map(item => item.id), baselineVersion: state.version };
}

test("state and first failures survive closing/reopening SQLite across Cron instances", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cf-dnspod-test-"));
  const filename = path.join(directory, "state.sqlite");
  const state = lineState(), measurement = round(state, 0, { current: { failures: { CU: 1 } } });
  const first = database(filename); await seed(first.store, allStates(), [measurement]); first.close();
  const second = database(filename, false);
  try { const rows = await second.store.rounds(now); assert.equal(rows[0].reports[1].carriers.find(row => row.line === "CU").failed, 1); assert.equal((await second.store.lines()).length, 4); }
  finally { second.close(); const target = path.resolve(directory); assert.ok(target.startsWith(path.resolve(tmpdir()) + path.sep)); await rm(target, { recursive: true, force: true }); }
});
test("slot replay, leases and rotating cursor prevent duplicate measurements and preserve order", async () => {
  const d = database();
  try {
    const store = d.store, original = await store.control();
    const claim = await store.claimRound(original, now, 36); assert.equal(claim.line, "CU");
    assert.equal(await store.claimRound(original, now, 36), null);
    await store.releaseProbe(claim.owner); assert.equal(await store.claimRound(await store.control(), now, 36), null);
    assert.equal((await store.claimRound(await store.control(), now + POLICY.slotMs, 36)).line, "CT");
  } finally { d.close(); }
});
test("rolling budget includes manual jobs and aborted jobs; 429 reset persists", async () => {
  const d = database();
  try {
    const state = lineState();
    for (let index = 0; index < 5; index++) await d.store.startRound(round(state, index, { startedAt: now - index * 60_000, round: { id: `budget-${index}` } }), 36);
    assert.equal(await d.store.claimRound(await d.store.control(), now, 36), null);
    await d.store.backoff(now + 3600_000);
    assert.equal((await new StateStore(d.db).control()).backoff_until, now + 3600_000);
  } finally { d.close(); }
});
test("publication attempts are unique, frozen writes stay blocked, and only 48-hour summaries are retained", async () => {
  const d = database();
  try {
    assert.equal((await d.store.control()).frozen, 1);
    const evidence = await publicationEvidence(d.store); assert.equal((await d.store.control()).frozen, 0);
    const owner = await d.store.claimSync(now);
    assert.equal(await d.store.beginSwitch("missing-evidence", "CU", now, {}, owner), false);
    assert.equal(await d.store.beginSwitch("one-round", "CU", now, {}, owner, { ...evidence, roundIds: evidence.roundIds.slice(0, 1) }), false);
    assert.equal(await d.store.beginSwitch("one", "CU", now, {}, owner, evidence), true);
    assert.equal(await d.store.beginSwitch("one", "CU", now, {}, owner, evidence), false);
    await d.store.finishSwitch("one", "verified", { ok: true });
    await d.store.startRound(round(lineState(), 0, { startedAt: now - POLICY.retentionMs - 1, round: { id: "expired" } }), 36);
    await d.store.prune(now);
    assert.equal(d.connection.prepare("SELECT COUNT(*) n FROM probe_rounds WHERE id='expired'").get().n, 0);
  } finally { d.close(); }
});
test("decision reads keep only the latest two rounds per line and retain partial rounds that break streaks", async () => {
  const d = database();
  try {
    const items = allStates().flatMap(state => [0, 1, 2].map(index => round(state, index, {
      startedAt: now - (3 - index) * POLICY.slotMs,
      ...(index === 2 ? { round: { status: "partial" } } : {}),
    })));
    await seed(d.store, allStates(), items);
    const latest = await d.store.latestRounds(now);
    assert.equal(latest.length, 8);
    for (const state of allStates()) {
      assert.deepEqual(latest.filter(item => item.line === state.line).map(item => item.id), [`round-${state.line}-2`, `round-${state.line}-1`]);
      assert.equal(latest.find(item => item.line === state.line).status, "partial");
    }
    assert.equal((await d.store.rounds(now)).length, 12);
  } finally { d.close(); }
});
test("additive lease migration preserves an existing frozen database and its evidence", async () => {
  const connection = new DatabaseSync(":memory:");
  try {
    connection.exec(await readFile(new URL("../migrations/0001_measurement_state.sql", import.meta.url), "utf8"));
    const body = JSON.stringify(lineState());
    connection.prepare("INSERT INTO line_state VALUES(?,?,?)").run("CU", body, now);
    connection.exec(await readFile(new URL("../migrations/0002_lease_owners.sql", import.meta.url), "utf8"));
    const control = connection.prepare("SELECT * FROM tool_control").get();
    assert.equal(control.frozen, 1); assert.equal(control.sync_owner, null); assert.equal(control.probe_owner, null);
    assert.equal(connection.prepare("SELECT body FROM line_state").get().body, body);
  } finally { connection.close(); }
});

test("batched sync snapshot preserves decision evidence, partial streak breakers and unsettled publication recovery", async () => {
  const d = database();
  try {
    const states = allStates();
    const items = states.flatMap(state => [0, 1, 2].map(index => round(state, index, {
      startedAt: now - (3 - index) * POLICY.slotMs,
      ...(index === 2 ? { round: { status: "partial" } } : {}),
    })));
    await seed(d.store, states, items);
    await d.store.freeze(false, now);
    // A pre-existing interrupted intent remains recoverable even after a later partial round.
    d.connection.prepare("INSERT INTO switch_history(id,line,at,status,body) VALUES(?,?,?,'attempting','{}')")
      .run("CU:version-CU:interrupted", "CU", now);
    await d.store.freeze(true, now);
    const expected = { control: await d.store.control(), lines: await d.store.lines(),
      rounds: await d.store.latestRounds(now), unsettled: await d.store.unsettledSwitches() };
    const calls = d.store.calls, actual = await d.store.syncSnapshot(now);
    assert.deepEqual(actual.control, expected.control);
    assert.deepEqual(actual.lines, expected.lines);
    assert.deepEqual(actual.unsettled, expected.unsettled);
    for (const state of states) assert.deepEqual(decideLine(state, actual.rounds, now), decideLine(state, expected.rounds, now));
    assert.equal(d.store.calls - calls, 1);
    assert.deepEqual(actual.rounds.map(item => [item.id, item.status]), expected.rounds.map(item => [item.id, item.status]));
    assert.deepEqual(await d.store.latestRounds(now), expected.rounds);
    assert.equal(actual.rounds.length, 8);
    assert.equal(actual.unsettled.length, 1);
    assert.equal(actual.unsettled[0].id, "CU:version-CU:interrupted");
    assert.equal(actual.unsettled[0].line, "CU");
    assert.equal(actual.control.frozen, 1);
    const probeCalls = d.store.calls, probe = await d.store.probeSnapshot();
    assert.deepEqual(probe, { control: expected.control, lines: expected.lines });
    assert.equal(d.store.calls - probeCalls, 1);
  } finally { d.close(); }
});

test("projected decisions match full stored reports across four lines, failures, invalid coverage and incomplete streaks", async () => {
  const d = database();
  try {
    const cases = [
      {}, { current: { failures: { CT: 1, CU: 1, CM: 1 } } },
      { current: { latency: 900 }, challenger: { latency: 300 } },
      { current: { failures: { CT: 2 } }, challenger: { failures: { CU: 1 } } },
      { challenger: { counts: { CU: 2 } } }, { challenger: { result: { status: "offline" } } },
      { challenger: { result: { tls: { authorized: false } } } },
      { challenger: { result: { rawBody: '{"ok":true,"service":"wrong"}' } } },
      { challenger: { result: { timings: { total: 14800 } } } },
      { challenger: { result: { timings: { total: null } } } },
      { round: { reports: [], status: "running", completedAt: undefined } }, { round: { status: "partial" } },
      { round: { baselineVersion: "other-version" } }, { round: { errors: [{ target: "test", error: "incomplete" }] } },
    ];
    for (const [index, options] of cases.entries()) {
      d.connection.exec("DELETE FROM probe_rounds");
      const states = allStates(), rounds = states.flatMap(state => [0, 1, 2].map(offset => round(state, offset,
        offset === 2 ? options : { current: { failures: { CT: 1, CU: 1, CM: 1 } } })));
      await seed(d.store, states, rounds);
      const full = await d.store.latestRounds(now), view = await d.store.syncSnapshot(now);
      assert.equal(view.rounds.length, 8);
      for (const state of states) assert.deepEqual(decideLine(state, view.rounds, now), decideLine(state, full, now), `case ${index}, ${state.line}`);
      assert.deepEqual(await d.store.rounds(now), JSON.parse(JSON.stringify(rounds.slice().sort((a, b) => b.startedAt - a.startedAt))));
    }
    for (const field of ["country", "asn", "state", "city", "network", "latitude", "longitude"]) {
      d.connection.exec("DELETE FROM probe_rounds");
      const state = lineState(), rounds = [0, 1].map(index => round(state, index, { current: { failures: { CU: 1 } } }));
      const sample = rounds[1].reports[2].results.find(row => row.asn === 4837);
      sample[field] = typeof sample[field] === "number" ? sample[field] + 1 : "changed-metadata";
      await seed(d.store, [state], rounds);
      const full = await d.store.latestRounds(now), view = await d.store.syncSnapshot(now);
      assert.deepEqual(decideLine(state, view.rounds, now), decideLine(state, full, now), field);
      assert.equal(decideLine(state, view.rounds, now).ip, state.candidates[1].ip, `${field}: mismatched cohort must lose to the comparable second candidate`);
    }
  } finally { d.close(); }
});
test("expired owners cannot release new leases, save snapshots or authorize DNS writes", async () => {
  const d = database();
  try {
    const evidence = await publicationEvidence(d.store);
    const first = await d.store.claimSync(now), later = now + POLICY.leaseMs + 1;
    const second = await d.store.claimSync(later); assert.notEqual(first, second);
    await d.store.releaseSync(first);
    assert.equal((await d.store.control()).sync_owner, second);
    await assert.rejects(d.store.saveLines([lineState("CU", { version: "stale-owner" })], later, first), /lease/);
    const expired = round(lineState(), 0, { startedAt: now - POLICY.retentionMs - 1, round: { id: "expired-but-protected" } });
    await d.store.startRound(expired, 36);
    await assert.rejects(d.store.saveLines([lineState("CU", { version: "stale-owner" })], later, first, true), /lease/);
    assert.equal(d.connection.prepare("SELECT COUNT(*) n FROM probe_rounds WHERE id=?").get(expired.id).n, 1);
    assert.equal(await d.store.beginSwitch("stale", "CU", later, {}, first, evidence), false);
    assert.notEqual((await d.store.lines()).find(row => row.line === "CU").version, "stale-owner");
    const p1 = await d.store.claimRound(await d.store.control(), now, 36);
    const item = round(lineState(), 0, { round: { id: p1.id, status: "running" } });
    await d.store.startRound(item, 36);
    const p2 = await d.store.claimRound(await d.store.control(), now + POLICY.slotMs, 36);
    await d.store.releaseProbe(p1.owner);
    assert.equal((await d.store.control()).probe_owner, p2.owner);
    await assert.rejects(d.store.saveRound(item, p1.owner, now + POLICY.slotMs), /lease/);
  } finally { d.close(); }
});

test("sync lease and evidence snapshot are acquired together; expired owners cannot reuse a successor's snapshot", async () => {
  const d = database();
  try {
    const states = allStates(), rounds = states.flatMap(state => [0, 1].map(index => round(state, index)));
    await seed(d.store, states, rounds);
    const calls = d.store.calls, first = await d.store.claimSyncSnapshot(now);
    assert.equal(d.store.calls - calls, 1); assert.equal(first.snapshot.control.sync_owner, first.owner);
    assert.deepEqual(first.snapshot, await d.store.syncSnapshot(now));
    assert.equal(await d.store.claimSyncSnapshot(now), null);
    const later = now + POLICY.leaseMs + 1, next = await d.store.claimSyncSnapshot(later);
    assert.notEqual(next.owner, first.owner); assert.equal(next.snapshot.control.sync_owner, next.owner);
    await d.store.releaseSync(first.owner);
    assert.equal((await d.store.control()).sync_owner, next.owner);
    await d.store.releaseSync(next.owner);
    d.connection.exec("UPDATE line_state SET body='invalid-json' WHERE line='CU'");
    await assert.rejects(d.store.claimSyncSnapshot(later + 1), /JSON/);
    assert.equal((await d.store.control()).sync_owner, null);
  } finally { d.close(); }
});

test("snapshot save and retention pruning roll back together if either operation fails", async () => {
  const d = database();
  try {
    await seed(d.store);
    const owner = await d.store.claimSync(now), state = lineState("CU", { version: "updated" });
    const expired = round(state, 0, { startedAt: now - POLICY.retentionMs - 1, round: { id: "expired" } });
    await d.store.startRound(expired, 36);
    d.connection.exec("CREATE TRIGGER reject_prune BEFORE DELETE ON probe_rounds BEGIN SELECT RAISE(ABORT,'prune failed'); END");
    await assert.rejects(d.store.saveLines([state], now, owner, true), /prune failed/);
    assert.equal((await d.store.lines()).find(row => row.line === "CU").version, "version-CU");
    assert.equal(d.connection.prepare("SELECT COUNT(*) n FROM probe_rounds WHERE id=?").get(expired.id).n, 1);
    d.connection.exec("DROP TRIGGER reject_prune");
    await d.store.saveLines([state], now, owner, true);
    assert.equal((await d.store.lines()).find(row => row.line === "CU").version, "updated");
    assert.equal(d.connection.prepare("SELECT COUNT(*) n FROM probe_rounds WHERE id=?").get(expired.id).n, 0);
  } finally { d.close(); }
});
test("freeze includes any in-flight publication lease in the safe TTL window", async () => {
  const d = database();
  try {
    const evidence = await publicationEvidence(d.store), owner = await d.store.claimSync(now);
    await d.store.freeze(true, now + 1000);
    assert.equal((await d.store.control()).frozen_at, now + POLICY.leaseMs);
    assert.equal(await d.store.beginSwitch("frozen", "CU", now + 1000, {}, owner, evidence), false);
    assert.equal(d.connection.prepare("SELECT COUNT(*) n FROM switch_history").get().n, 0);
  } finally { d.close(); }
});
test("CLI transaction adapter rolls back audit and snapshot together on a real SQLite failure", async () => {
  const d = database();
  try {
    const requests = [];
    const adapter = remoteState(cliConfig, async (path, request) => {
      if (!path.endsWith("/query")) return { uuid: cliScope.databaseId, name: "cf-dnspod-state" };
      requests.push(request.body);
      assert.equal(path, `/accounts/${cliScope.accountId}/d1/database/${cliScope.databaseId}/query`);
      const items = request.body.batch ?? [request.body];
      return d.db.batch(items.map(item => d.db.prepare(item.sql).bind(...item.params)));
    }, cliScope);
    const store = new StateStore(adapter), evidence = await publicationEvidence(store);
    const owner = await store.claimSync(now);
    assert.equal(await store.beginSwitch("atomic", "CU", now, {}, owner, evidence), true);
    d.connection.exec("CREATE TRIGGER reject_snapshot BEFORE UPDATE ON line_state BEGIN SELECT RAISE(ABORT,'snapshot failed'); END");
    await assert.rejects(store.completeSwitch("atomic", { verified: true }, lineState("CU", { version: "new" }), now, owner), /snapshot failed/);
    assert.equal(d.connection.prepare("SELECT status FROM switch_history WHERE id='atomic'").get().status, "attempting");
    assert.equal((await store.lines()).find(row => row.line === "CU").version, "version-CU");
    assert.ok(requests.some(body => body.batch?.length === 2));
  } finally { d.close(); }
});
test("CLI state adapter refuses a different account or a business database before making requests", async () => {
  const config = cliConfig;
  for (const changed of [
    { database: { ...config.database, accountId: "another-account" } },
    { database: { ...config.database, name: "other-database" } },
    { database: { ...config.database, id: "another-database" } },
  ]) assert.throws(() => remoteState(changed, () => { assert.fail("Must not access another account/database"); }, cliScope), /dedicated tool state/);
});
