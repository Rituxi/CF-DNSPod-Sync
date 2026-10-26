import assert from "node:assert/strict";
import test from "node:test";
import { parseV2RaySSR, parseHostMonit, parseChinaTime, rejection, selectLines, readCandidates } from "../src/sources.ts";
import { candidate, selections, now, v2html, fixture } from "./fixtures.mjs";

test("V2RaySSR parses the four explicit lines and preserves provider rank, not latency order", () => {
  const rows = parseV2RaySSR(v2html([candidate("CT", { rank: 1, latencyMs: 200 }), candidate("CT", { rank: 2, latencyMs: 20 }), candidate("DEFAULT")]));
  assert.equal(rows.length, 3);
  assert.equal(selectLines(rows, now, () => true).find(row => row.line === "CT").candidate.latencyMs, 200);
  assert.equal(selectLines(parseV2RaySSR(v2html()), now, () => true).filter(row => row.candidate).length, 4);
});
test("HTML structure changes and non-IPv4 pages do not produce fabricated candidates", () => {
  for (const html of ["error code: 1000", v2html().replaceAll("<td>", "<th>"), v2html().replaceAll("ms</td>", "seconds</td>")]) assert.throws(() => parseV2RaySSR(html), /changed|unavailable/);
});
test("timestamps require exact valid China-time dates and never use fetch time", () => {
  assert.equal(parseChinaTime("2026/10/25 21:00:00"), now);
  assert.equal(parseChinaTime("2026-10-25 21:00:00"), now);
  for (const time of ["2026-02-30 12:00:00", "2026-10-25 25:00:00", "2026-10-25", null, now]) assert.ok(Number.isNaN(parseChinaTime(time)));
});
test("HostMonit accepts only explicit matching carrier lines and has no implicit default", () => {
  const data = { code: 200, info: { CT: [{ ip: "104.16.0.2", line: "CT", latency: 40, loss: 0, time: "2026-10-25 21:00:00" }],
    CU: [{ ip: "104.16.0.3", line: "CT", latency: 30, loss: 0, time: "2026-10-25 21:00:00" }] } };
  const rows = parseHostMonit(data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, "CT");
  assert.equal(selectLines(rows, now, () => true)[0].candidate, null);
  assert.throws(() => parseHostMonit({ status: true, info: {} }), /schema/);
});
test("each carrier independently falls back; default is never borrowed from a carrier", () => {
  const rows = [candidate("CT", { source: "hostmonit", ip: "104.16.0.10" }), candidate("CU"),
    candidate("CU", { source: "hostmonit", ip: "104.16.0.11" }), candidate("CM", { measuredAt: now - 7 * 3600_000 }),
    candidate("CM", { source: "hostmonit", ip: "104.16.0.12" })];
  const selected = selectLines(rows, now, () => true);
  assert.deepEqual(selected.map(row => row.candidate?.source ?? null), [null, "hostmonit", "v2rayssr", "hostmonit"]);
});
for (const [label, change, expected] of [
  ["invalid IPv4", { ip: "999.16.0.1" }, "invalid-ipv4"], ["leading-zero IPv4", { ip: "104.016.0.1" }, "invalid-ipv4"],
  ["stale measurement", { measuredAt: now - 7 * 3600_000 }, "stale"], ["future timestamp", { measuredAt: now + 6 * 60_000 }, "future-measurement"],
  ["missing timestamp", { measuredAt: NaN }, "invalid-measurement-time"], ["high loss", { lossPercent: 1.1 }, "loss"],
  ["string metric", { lossPercent: "0" }, "loss"], ["high latency", { latencyMs: 1001 }, "latency"], ["negative latency", { latencyMs: -1 }, "latency"],
]) test(`filter rejects ${label}`, () => assert.equal(rejection(candidate("CT", change), now, () => true), expected));
test("filter rejects non-Cloudflare addresses and accepts the configured boundary", () => {
  assert.equal(rejection(candidate(), now, () => false), "outside-cloudflare");
  assert.equal(rejection(candidate("CT", { measuredAt: now - 6 * 3600_000, lossPercent: 1, latencyMs: 1000 }), now, () => true), null);
});
test("source outages yield four empty selections with diagnostic errors; no DNS fallback", async () => {
  const f = fixture({ sourceFailure: true });
  const pool = await readCandidates(f.fetcher, now);
  assert.equal(pool.sources[0].status, "unavailable");
  assert.ok(pool.selections.every(row => row.candidate === null));
  assert.ok(!f.calls.some(call => call.url.includes("dns-query")));
});
test("official range lookup failure stops the run without DNS changes", async () => {
  const f = fixture({ rangeFailure: true });
  await assert.rejects(readCandidates(f.fetcher, now), /503/);
  assert.equal(f.writeCount, 0);
});
