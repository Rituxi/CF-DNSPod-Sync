import { getJson, type Fetcher } from "./network.ts";
import { DNS_CONFIG, LINES } from "./config.ts";
import { type StateDatabase } from "./state.ts";

export interface DnsEnv {
  DNSPOD_DOMAIN: string; DNSPOD_DOMAIN_ID: string;
  SYNC_MODE: "observe" | "sync" | "paused";
  TENCENTCLOUD_SECRET_ID?: string; TENCENTCLOUD_SECRET_KEY?: string;
  STATE?: StateDatabase;
}
export interface DnsRecord {
  RecordId: number; Name: string; Type: string; Value: string;
  Line: string; LineId: string; TTL: number; Status: string; Remark?: string; UpdatedOn?: string;
}
export interface DnsLine { Name: string; LineId: string }

const ENDPOINT = "https://dnspod.tencentcloudapi.com/";
const encoder = new TextEncoder();
const hex = (data: ArrayBuffer) => [...new Uint8Array(data)].map(byte => byte.toString(16).padStart(2, "0")).join("");
async function sha256(value: string) { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function hmac(key: string | ArrayBuffer, value: string) {
  const material = typeof key === "string" ? encoder.encode(key) : key;
  const imported = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
}
async function signingKey(secretKey: string, date: string): Promise<CryptoKey> {
  const key = await hmac(await hmac(await hmac(`TC3${secretKey}`, date), "dnspod"), "tc3_request");
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

// Use Node's Web Crypto without a Tencent SDK dependency.
export async function signRequest(secretId: string, secretKey: string, action: string, payload: string, timestamp: number, preparedKey?: CryptoKey) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/dnspod/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:dnspod.tencentcloudapi.com\n\ncontent-type;host\n${await sha256(payload)}`;
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha256(canonical)}`;
  const signature = hex(await crypto.subtle.sign("HMAC", preparedKey ?? await signingKey(secretKey, date), encoder.encode(toSign)));
  return { "content-type": "application/json; charset=utf-8",
    "x-tc-action": action, "x-tc-version": "2021-03-23", "x-tc-timestamp": String(timestamp),
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}` };
}

export function validateEnv(env: DnsEnv): void {
  if (env.DNSPOD_DOMAIN !== DNS_CONFIG.domain || env.DNSPOD_DOMAIN_ID !== DNS_CONFIG.domainId ||
    !["observe", "sync", "paused"].includes(env.SYNC_MODE)) throw new Error("Configuration must target the dedicated pick.luro.qzz.io test zone and a valid mode");
}

export class DnsPod {
  private env: DnsEnv;
  private fetcher: Fetcher;
  private now: () => number;
  private signing?: { date: string; key: Promise<CryptoKey> };
  constructor(env: DnsEnv, fetcher: Fetcher = fetch, now = () => Date.now()) {
    validateEnv(env); this.env = env; this.fetcher = fetcher; this.now = now;
  }

  async call(action: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!["DescribeDomain", "DescribeRecordLineList", "DescribeRecordList", "DescribeRecord", "ModifyRecord"].includes(action)) throw new Error("DNSPod action outside tool scope");
    if (!this.env.TENCENTCLOUD_SECRET_ID?.trim() || !this.env.TENCENTCLOUD_SECRET_KEY?.trim()) throw new Error("Missing Tencent Cloud API credentials; run scripts/set-credentials.ps1 locally");
    if (Object.hasOwn(params, "Domain") || Object.hasOwn(params, "DomainId")) throw new Error("DNSPod domain cannot be overridden");
    if (action === "ModifyRecord" && (params.SubDomain !== "@" || params.RecordType !== "A" ||
      !LINES.some(line => line.name === params.RecordLine) || params.TTL !== DNS_CONFIG.ttl)) throw new Error("Write outside the four dedicated A records");
    const payload = JSON.stringify({ ...params, Domain: this.env.DNSPOD_DOMAIN });
    const timestamp = Math.floor(this.now() / 1000), date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    // Reuse only within this client's invocation, with an explicit UTC-date boundary.
    // This avoids repeatedly deriving the same TC3 key for inspection and read-backs.
    if (this.signing?.date !== date) this.signing = { date, key: signingKey(this.env.TENCENTCLOUD_SECRET_KEY.trim(), date) };
    const headers = await signRequest(this.env.TENCENTCLOUD_SECRET_ID.trim(), this.env.TENCENTCLOUD_SECRET_KEY.trim(), action, payload, timestamp, await this.signing.key);
    const data = await getJson(this.fetcher, ENDPOINT, { method: "POST", headers, body: payload });
    const response = data?.Response;
    if (response?.Error) {
      // Never echo the server message or request payload; retain a useful non-secret error code.
      const code = typeof response.Error.Code === "string" && /^[A-Za-z0-9.]+$/.test(response.Error.Code) ? response.Error.Code : "Unknown";
      throw new Error(`DNSPod ${action} rejected: ${code}`);
    }
    if (!response || typeof response.RequestId !== "string") throw new Error(`DNSPod ${action} returned an invalid response`);
    return response;
  }

  async inspect() {
    const domain = (await this.call("DescribeDomain")).DomainInfo;
    if (domain?.Domain !== DNS_CONFIG.domain || String(domain?.DomainId) !== DNS_CONFIG.domainId || typeof domain.Grade !== "string") throw new Error("DNSPod domain identity mismatch");
    const [lineResponse, records] = await Promise.all([
      this.call("DescribeRecordLineList", { DomainGrade: domain.Grade }), this.records(),
    ]);
    if (!Array.isArray(lineResponse.LineList)) throw new Error("DNSPod line list schema changed");
    const lines: DnsLine[] = LINES.map(line => {
      const matches = lineResponse.LineList.filter((item: any) => item.Name === line.name);
      if (matches.length !== 1 || typeof matches[0].LineId !== "string") throw new Error(`DNSPod line unavailable: ${line.name}`);
      return { Name: line.name, LineId: matches[0].LineId };
    });
    if (new Set(lines.map(line => line.LineId)).size !== 4) throw new Error("Duplicate DNSPod line IDs");
    return { domain: domain.Domain, domainId: domain.DomainId, grade: domain.Grade, lines, records };
  }

  async records(): Promise<DnsRecord[]> {
    const response = await this.call("DescribeRecordList", { SubDomain: "@", Limit: 100, ErrorOnEmpty: "no" });
    if (!Array.isArray(response.RecordList) || response.RecordList.length >= 100) throw new Error("DNSPod record list missing or truncated");
    const records: DnsRecord[] = response.RecordList;
    if (records.some(row => row.Name !== "@" || !Number.isSafeInteger(row.RecordId) || row.RecordId <= 0 ||
      typeof row.LineId !== "string" || typeof row.Type !== "string" || typeof row.Value !== "string")) throw new Error("DNSPod record identity invalid");
    return records;
  }

  async record(recordId: number): Promise<DnsRecord> {
    const row = (await this.call("DescribeRecord", { RecordId: recordId })).RecordInfo;
    if (!row || row.Id !== recordId) throw new Error("DNSPod read-back record ID mismatch");
    return { RecordId: row.Id, Name: row.SubDomain, Type: row.RecordType, Value: row.Value,
      Line: row.RecordLine, LineId: row.RecordLineId, TTL: row.TTL, Status: row.Enabled === 1 ? "ENABLE" : "DISABLE",
      Remark: row.Remark, UpdatedOn: row.UpdatedOn };
  }
}
