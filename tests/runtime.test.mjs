import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { StateStore } from "../src/state.ts";
import { synchronize } from "../src/sync.ts";
import { seed, allStates, round } from "./state-fixtures.mjs";
import { env, now, fixture } from "./fixtures.mjs";
import { POLICY } from "../src/config.ts";
import { decideLine } from "../src/selection.ts";

// The installed workerd supports this date; production keeps its own configured date.
const runtime = options => new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-10-13", ...options }));

test("native Workers stream coalesces fragments without losing UTF-8 or the response size bound", async () => {
  const network = stripTypeScriptTypes(await readFile(new URL("../src/network.ts", import.meta.url), "utf8"));
  const mf = runtime({ script: network + `
    export default { async fetch(request) {
      const large = new URL(request.url).pathname === "/oversized";
      const length = new URL(request.url).searchParams.get("length");
      const expected = length !== null ? "x".repeat(Number(length)) : large ? "x".repeat(1048577) : "a".repeat(65535) + "电信联通移动".repeat(12000);
      const bytes = new TextEncoder().encode(expected), stream = new FixedLengthStream(bytes.length);
      const inspection = stream.readable.getReader({ mode: "byob" }), proto = Object.getPrototypeOf(inspection);
      inspection.releaseLock();
      const original = proto.readAtLeast; let reads = 0, allocated = 0;
      proto.readAtLeast = function(...args) { reads++; allocated += args[1].byteLength; return original.apply(this, args); };
      const writer = stream.writable.getWriter();
      const producing = (async () => {
        try { for (let offset = 0; offset < bytes.length; offset += 257) await writer.write(bytes.slice(offset, offset + 257)); await writer.close(); }
        catch { /* The bounded reader cancels the oversized stream. */ }
      })();
      try {
        const hint = new URL(request.url).searchParams.get("hint");
        const headers = hint === null ? {} : { "content-length": hint };
        if (new URL(request.url).searchParams.has("encoded")) headers["content-encoding"] = "gzip";
        const actual = await readLimitedText(new Response(stream.readable, { headers }), "native stream"); await producing;
        return Response.json({ exact: actual === expected, reads, allocated });
      } catch (error) {
        await producing; return Response.json({ bounded: /1 MiB/.test(error.message), reads });
      } finally { proto.readAtLeast = original; }
    } };
  ` });
  try {
    const normal = await (await mf.dispatchFetch("http://local.test/")).json();
    const oversized = await (await mf.dispatchFetch("http://local.test/oversized")).json();
    assert.equal(normal.exact, true); assert.equal(normal.reads, 5);
    assert.equal(oversized.bounded, true); assert.ok(oversized.reads <= 17);
    for (const [length, reads] of [[0, 1], [32768, 1], [65536, 2], [65537, 2], [1048576, 17]]) {
      const result = await (await mf.dispatchFetch(`http://local.test/?length=${length}`)).json();
      assert.equal(result.exact, true, `exact bytes at ${length}`);
      assert.equal(result.reads, reads, `native reads at ${length}`);
    }
    const small = await (await mf.dispatchFetch("http://local.test/?length=896&hint=896")).json();
    assert.equal(small.exact, true); assert.equal(small.reads, 1); assert.equal(small.allocated, 897);
    for (const hint of ["0", "1", "99999999", "invalid"]) {
      const result = await (await mf.dispatchFetch(`http://local.test/?length=65537&hint=${hint}`)).json();
      assert.equal(result.exact, true, `a misleading length hint ${hint} must not truncate data`);
    }
    assert.equal((await (await mf.dispatchFetch("http://local.test/oversized?hint=1")).json()).bounded, true);
    const encoded = await (await mf.dispatchFetch("http://local.test/?length=65537&hint=1&encoded")).json();
    assert.equal(encoded.exact, true); assert.equal(encoded.reads, 2);
  } finally { await mf.dispose(); }
});

test("native fetch preserves unknown-length and gzip bodies and bounds decompressed bytes", async () => {
  const expected = "a".repeat(65535) + "电信联通移动".repeat(12000);
  const bytes = Buffer.from(expected), compressed = gzipSync(bytes), overflow = gzipSync(Buffer.alloc(1048577, 120));
  const server = createServer((request, response) => {
    if (request.url === "/chunked") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      for (let offset = 0; offset < bytes.length; offset += 257) response.write(bytes.subarray(offset, offset + 257));
      response.end();
    } else {
      const body = request.url === "/oversized" ? overflow : compressed;
      response.writeHead(200, { "content-encoding": "gzip", "content-length": body.length });
      response.end(body);
    }
  });
  let mf;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const network = stripTypeScriptTypes(await readFile(new URL("../src/network.ts", import.meta.url), "utf8"));
    mf = runtime({ script: network + `
      export default { async fetch(request) {
        try { return Response.json({ text: await getText(fetch, ${JSON.stringify(origin)} + new URL(request.url).pathname) }); }
        catch (error) { return Response.json({ error: error.message }); }
      } };
    ` });
    for (const path of ["/chunked", "/gzip"]) {
      const result = await (await mf.dispatchFetch(`http://local.test${path}`)).json();
      assert.equal(result.text, expected, `${path}: real native fetch must preserve the complete UTF-8 text`);
    }
    assert.ok(overflow.length < 65536);
    assert.match((await (await mf.dispatchFetch("http://local.test/oversized")).json()).error, /1 MiB/);
  } finally {
    await mf?.dispose();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

test("native D1 rolls back a failed combined claim and protects snapshot/pruning during lease takeover", async () => {
  const mf = runtime({ script: "export default { fetch() { return new Response('local'); } };", d1Databases: { STATE: "review-batch-state" } });
  try {
    const db = await mf.getD1Database("STATE"), store = new StateStore(db), states = allStates();
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(sql.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
    }
    await seed(store, states, states.flatMap(state => [0, 1].map(index => round(state, index, { current: { failures: { CU: 1 } } }))));
    await db.prepare("INSERT INTO probe_rounds(id,line,baseline_version,started_at,reserved_tests,status,body) VALUES('bad','CU','version-CU',?,0,'running','invalid-json')").bind(now).run();
    await assert.rejects(store.claimSyncSnapshot(now), /json/i);
    const rolledBack = await store.control();
    assert.equal(rolledBack.sync_owner, null); assert.equal(rolledBack.sync_lease_until, 0);
    await db.prepare("DELETE FROM probe_rounds WHERE id='bad'").run();
    const first = await store.claimSyncSnapshot(now), full = await store.latestRounds(now);
    for (const state of states) assert.deepEqual(decideLine(state, first.snapshot.rounds, now), decideLine(state, full, now));
    assert.ok(first.snapshot.rounds.every(item => item.reports.every(report => report.results.every(sample => typeof sample.ok === "boolean"))));
    assert.equal(await store.claimSyncSnapshot(now), null);
    const expired = round(states[0], 9, { startedAt: now - POLICY.retentionMs - 1, round: { id: "expired" } });
    await store.startRound(expired, 36);
    const later = now + POLICY.leaseMs + 1, next = await store.claimSyncSnapshot(later);
    const changed = states.map(state => ({ ...state, version: `updated-${state.line}` }));
    await assert.rejects(store.saveLines(changed, later, first.owner, true), /lease/);
    assert.deepEqual(await store.lines(), states.slice().sort((a, b) => a.line.localeCompare(b.line)));
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM probe_rounds WHERE id='expired'").all()).results[0].n, 1);
    await store.releaseSync(first.owner); assert.equal((await store.control()).sync_owner, next.owner);
    await db.prepare("CREATE TRIGGER reject_prune BEFORE DELETE ON probe_rounds BEGIN SELECT RAISE(ABORT,'prune failed'); END").run();
    await assert.rejects(store.saveLines(changed, later, next.owner, true), /prune failed/);
    assert.deepEqual(await store.lines(), states.slice().sort((a, b) => a.line.localeCompare(b.line)));
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM probe_rounds WHERE id='expired'").all()).results[0].n, 1);
    await db.prepare("DROP TRIGGER reject_prune").run();
    await store.saveLines(changed, later, next.owner, true);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM probe_rounds WHERE id='expired'").all()).results[0].n, 0);
    assert.deepEqual(await store.lines(), changed.slice().sort((a, b) => a.line.localeCompare(b.line)));
    await store.releaseSync(next.owner); assert.equal((await store.control()).sync_owner, null);
  } finally { await mf.dispose(); }
});

test("native D1 runs all migrations, four-line publication and an atomic audit/snapshot rollback", async () => {
  const mf = runtime({ script: "export default { fetch() { return new Response('local'); } };", d1Databases: { STATE: "test-state" } });
  try {
    const db = await mf.getD1Database("STATE"), store = new StateStore(db);
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(sql.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
    }
    const states = allStates();
    const rounds = states.flatMap(state => [0, 1].map(index => round(state, index, { current: { failures: { [state.line === "DEFAULT" ? "CT" : state.line]: 1 } } })));
    await seed(store, states, rounds);
    const f = fixture({ rows: states.flatMap(state => state.candidates), readBackFailures: 2 });
    const result = await synchronize({ ...env, STATE: db }, { fetcher: f.fetcher, now, sleep: async () => {} });
    assert.equal(result.outcomes.filter(outcome => outcome.status === "updated").length, 4);
    assert.equal(f.writeCount, 4); assert.ok(result.countedSubrequests <= 50);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM switch_history WHERE status='verified'").all()).results[0].n, 4);
    const before = JSON.stringify(await store.lines()), state = (await store.lines())[0];
    const at = now + 2 * POLICY.slotMs, owner = await store.claimSync(at);
    const proof = [4, 5].map((index, offset) => round(state, index, { startedAt: now + offset * POLICY.slotMs + 1000 }));
    for (const item of proof) { await store.startRound(item, 36); await store.saveRound(item); }
    const pending = round(state, 6, { startedAt: at, round: { status: "running", completedAt: undefined } });
    await store.startRound(pending, 36);
    assert.equal(await store.beginSwitch("stale-evidence", state.line, at, {}, owner,
      { roundIds: [...proof].reverse().map(item => item.id), baselineVersion: state.version }), false);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM switch_history WHERE id='stale-evidence'").all()).results[0].n, 0);
    await store.beginSwitch("rollback-test", state.line, at, {}, owner);
    await db.prepare("CREATE TRIGGER reject_snapshot BEFORE UPDATE ON line_state BEGIN SELECT RAISE(ABORT,'snapshot failed'); END").run();
    await assert.rejects(store.completeSwitch("rollback-test", {}, state, at, owner), /snapshot failed/);
    assert.equal((await db.prepare("SELECT status FROM switch_history WHERE id='rollback-test'").all()).results[0].status, "attempting");
    assert.equal(JSON.stringify(await store.lines()), before);
  } finally { await mf.dispose(); }
});
