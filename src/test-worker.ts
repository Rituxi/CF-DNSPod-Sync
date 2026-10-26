import { TEST_SERVICE } from "./config.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, max-age=0",
      "cdn-cache-control": "no-store", "x-test-service": TEST_SERVICE };
    if (new URL(request.url).pathname !== "/health") return new Response(JSON.stringify({ ok: false, service: TEST_SERVICE, error: "not-found" }), { status: 404, headers });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(JSON.stringify({ ok: false, service: TEST_SERVICE, error: "method-not-allowed" }), { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : JSON.stringify({ ok: true, service: TEST_SERVICE, purpose: "independent-carrier-acceptance" }), { status: 200, headers });
  },
};
