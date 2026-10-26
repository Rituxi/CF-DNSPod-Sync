import { POLICY } from "./config.ts";
import { CARRIERS } from "./measurement.ts";
import { ipv4Number, readLimitedText, type Fetcher } from "./network.ts";
export const GLOBALPING_API = "https://api.globalping.io/v1";
export function measurementRequest(target: string, healthUrl: string, reuse?: { id: string; count: number }) {
  if (healthUrl !== "https://probe.luro.qzz.io/health") throw new Error("Probe is restricted to the independent test health URL");
  const health = new URL(healthUrl);
  if (target !== health.hostname) ipv4Number(target);
  return { type: "http", target, timeout: POLICY.probeTimeoutSeconds,
    ...(reuse ? { locations: reuse.id, limit: reuse.count } : { locations: CARRIERS.map(carrier => ({ country: "CN", asn: carrier.asn, limit: POLICY.probesPerCarrier })) }),
    measurementOptions: { protocol: "HTTP2", port: 443, ...(target === health.hostname ? { ipVersion: 4 } : {}),
      request: { method: "GET", host: health.hostname, path: health.pathname, headers: { "Cache-Control": "no-cache" } } },
  };
}
export class RateLimitError extends Error {
  retryAt: number;
  constructor(retryAt: number) { super("Globalping HTTP 429; waiting for the provider reset time"); this.retryAt = retryAt; }
}
export class Globalping {
  fetcher: Fetcher; now: () => number; calls = 0;
  constructor(fetcher: Fetcher, now = () => Date.now()) { this.fetcher = fetcher; this.now = now; }
  async request(path: string, init: RequestInit = {}, etag?: string): Promise<{ data?: any; etag?: string; notModified?: boolean }> {
    this.calls++;
    // Call the injected fetch function without binding it to this client.
    const fetcher = this.fetcher;
    const response = await fetcher(`${GLOBALPING_API}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", "user-agent": "cf-dnspod-sync/2.0 (+independent-network-test)", "accept-encoding": "gzip", ...(etag ? { "if-none-match": etag } : {}) } });
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
      const retryAt = seconds !== null ? this.now() + Math.max(1, seconds) * 1000 : retry && Number.isFinite(Date.parse(retry)) ? Date.parse(retry) : this.now() + 3600_000;
      await response.body?.cancel(); throw new RateLimitError(retryAt);
    }
    if (response.status === 304) { await response.body?.cancel(); return { notModified: true, etag }; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Globalping HTTP ${response.status}`); }
    const text = await readLimitedText(response, "Globalping");
    try { return { data: JSON.parse(text), etag: response.headers.get("etag") ?? undefined }; }
    catch { throw new Error("Globalping invalid JSON"); }
  }
  async limits() {
    const limit = (await this.request("/limits")).data?.rateLimit?.measurements?.create;
    if (!limit || !Number.isFinite(limit.remaining) || !Number.isFinite(limit.reset) || limit.remaining < 0 || limit.reset < 0) throw new Error("Globalping limit response changed");
    return { remaining: limit.remaining as number, resetAt: this.now() + limit.reset * 1000 };
  }
  async create(target: string, url: string, reuse?: { id: string; count: number }) {
    const data = (await this.request("/measurements", { method: "POST", body: JSON.stringify(measurementRequest(target, url, reuse)) })).data;
    if (typeof data?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.id) || !Number.isInteger(data.probesCount) || data.probesCount < 1 || data.probesCount > 9) throw new Error("Unexpected measurement allocation");
    return { id: data.id as string, count: data.probesCount as number, target, reportUrl: `${GLOBALPING_API}/measurements/${data.id}` };
  }
}
