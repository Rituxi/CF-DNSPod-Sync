import assert from "node:assert/strict";
import test from "node:test";
import { getText, cloudflareRangeCheck } from "../src/network.ts";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
test("redirects cannot forward Tencent credentials to another host", async () => {
  let calls = 0;
  await assert.rejects(getText(async (url, init) => {
    calls++; assert.equal(init.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://example.com" } });
  }, "https://dnspod.tencentcloudapi.com/", { headers: { authorization: "test-only" } }), /302/);
  assert.equal(calls, 1);
});
test("oversized pages stop reading, and malformed official ranges cannot validate addresses", async () => {
  await assert.rejects(getText(async () => new Response("x".repeat(1024 * 1024 + 1)), "https://v2rayssr.com/cfip/"), /1 MiB/);
  await assert.rejects(cloudflareRangeCheck(async () => Response.json({ success: true, result: { ipv4_cidrs: ["104.16.0.0/invalid"] } })), /Invalid published/);
});
test("Chinese source text remains intact when UTF-8 characters span small network chunks", async () => {
  const value = "电信/联通/移动：104.16.0.1";
  const bytes = new TextEncoder().encode(value);
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }));
  assert.equal(await getText(async () => response, "https://v2rayssr.com/cfip/"), value);
});
test("standard byte streams retain UTF-8 and the actual byte cap", async () => {
  const value = "a".repeat(65535) + "电信联通移动".repeat(12000);
  const bytes = new TextEncoder().encode(value);
  const stream = content => new ReadableStream({ type: "bytes", start(controller) {
    for (let offset = 0; offset < content.length; offset += 257) controller.enqueue(content.slice(offset, offset + 257));
    controller.close();
  } });
  assert.equal(await getText(async () => new Response(stream(bytes)), "https://v2rayssr.com/cfip/"), value);
  await assert.rejects(getText(async () => new Response(stream(new Uint8Array(1024 * 1024 + 1))), "https://v2rayssr.com/cfip/"), /1 MiB/);
});

test("real Node fetch preserves chunked and gzip UTF-8 and caps decompressed data", async () => {
  const expected = "a".repeat(65535) + "电信联通移动".repeat(12000);
  const bytes = Buffer.from(expected), compressed = gzipSync(bytes), overflow = gzipSync(Buffer.alloc(1048577, 120));
  const server = createServer((request, response) => {
    if (request.url === "/chunked") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      for (let offset = 0; offset < bytes.length; offset += 257) response.write(bytes.subarray(offset, offset + 257));
      response.end();
    } else {
      const body = request.url === "/oversized" ? overflow : compressed;
      response.writeHead(200, { "content-encoding": "gzip", "content-length": body.length }); response.end(body);
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/chunked", "/gzip"]) assert.equal(await getText(fetch, origin + path), expected);
    assert.ok(overflow.length < 65536);
    await assert.rejects(getText(fetch, origin + "/oversized"), /1 MiB/);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test("the exact response bound is accepted and a false length header cannot truncate data", async () => {
  for (const length of [0, 65536, 65537, 1048576]) {
    const value = "x".repeat(length);
    assert.equal(await getText(async () => new Response(value, { headers: { "content-length": "1" } }), "https://source.test"), value);
  }
});
