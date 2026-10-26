import { LINES, DNS_CONFIG } from "../src/config.ts";
export const now = Date.parse("2026-10-25T13:00:00Z");
export const env = { DNSPOD_DOMAIN: DNS_CONFIG.domain, DNSPOD_DOMAIN_ID: DNS_CONFIG.domainId,
  SYNC_MODE: "sync", TENCENTCLOUD_SECRET_ID: "test-id", TENCENTCLOUD_SECRET_KEY: "test-key" };
export const dnsLines = LINES.map((line, index) => ({ Name: line.name, LineId: ["0", "10=0", "10=1", "10=3"][index] }));
export const candidate = (line = "DEFAULT", extra = {}) => ({ ip: `104.16.0.${LINES.findIndex(item => item.id === line) + 1}`,
  source: "v2rayssr", line, rank: 1, lossPercent: 0, latencyMs: 50, measuredAt: now - 60_000, ...extra });
export const selections = () => LINES.map(line => ({ line: line.id, name: line.name, candidate: candidate(line.id) }));
export const record = (index = 0, extra = {}) => ({ RecordId: 100 + index, Name: "@", Type: "A", Value: `104.16.0.${index + 1}`,
  Line: dnsLines[index].Name, LineId: dnsLines[index].LineId, TTL: 600, Status: "ENABLE", Remark: DNS_CONFIG.owner, ...extra });
export const transition = () => record(0, { Type: "CNAME", Value: "ipv4.luro.qzz.io.", Remark: "" });
export function v2html(rows = selections().map(selection => selection.candidate)) {
  const labels = { DEFAULT: "多线", CT: "电信", CU: "联通", CM: "移动" };
  return `<table>${rows.map(row => `<tr><td>${row.rank}</td><td><span>${labels[row.line]}</span></td><td>${row.ip}<div>已复制!</div></td><td>${row.lossPercent}%</td><td>${row.latencyMs}ms</td><td>10mb/s</td><td>80mb</td><td>-</td><td>${new Date(row.measuredAt + 8 * 3600_000).toISOString().slice(0, 19).replaceAll("-", "/").replace("T", " ")}</td></tr>`).join("")}</table>`;
}
export function fixture(options = {}) {
  const calls = [];
  const records = structuredClone(options.records ?? selections().map((_, index) => record(index)));
  let writeCount = 0;
  const writtenIds = new Set(), readBackAttempts = new Map();
  const fetcher = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const action = init.headers?.["x-tc-action"];
    calls.push({ url, action, body });
    if (url.includes("dnspod.tencentcloudapi.com")) {
      if (options.rejectAction === action && (!options.rejectLine || body.RecordLine === options.rejectLine)) return Response.json({ Response: { Error: { Code: "AuthFailure.UnauthorizedOperation", Message: "secret-must-not-appear" }, RequestId: "request" } });
      assertDomain(body.Domain);
      let result;
      if (action === "DescribeDomain") result = { DomainInfo: { Domain: options.wrongDomain ? "other.example.com" : env.DNSPOD_DOMAIN, DomainId: Number(env.DNSPOD_DOMAIN_ID), Grade: "DP_FREE" } };
      else if (action === "DescribeRecordLineList") result = { LineList: options.lines ?? dnsLines };
      else if (action === "DescribeRecordList") result = { RecordList: options.truncated ? Array.from({ length: 100 }, () => record()) : records };
      else if (action === "CreateRecord" || action === "ModifyRecord") {
        writeCount++;
        const id = action === "CreateRecord" ? 200 + writeCount : body.RecordId;
        writtenIds.add(id);
        const row = { RecordId: id, Name: body.SubDomain, Type: body.RecordType, Value: body.Value, Line: body.RecordLine,
          LineId: body.RecordLineId, TTL: body.TTL, Status: body.Status, Remark: body.Remark ?? records.find(row => row.RecordId === id)?.Remark };
        const index = records.findIndex(row => row.RecordId === id);
        if (index >= 0) records[index] = row; else records.push(row);
        result = { RecordId: id };
      } else if (action === "ModifyRecordRemark") {
        records.find(row => row.RecordId === body.RecordId).Remark = body.Remark;
        result = {};
      } else if (action === "DescribeRecord") {
        const row = records.find(row => row.RecordId === body.RecordId);
        const attempts = writtenIds.has(row.RecordId) ? (readBackAttempts.get(row.RecordId) ?? 0) + 1 : 0;
        if (attempts) readBackAttempts.set(row.RecordId, attempts);
        result = { RecordInfo: { Id: row.RecordId, SubDomain: row.Name, RecordType: row.Type, Value: (options.badReadback && attempts) || (attempts && attempts <= (options.readBackFailures ?? 0)) ? "104.16.0.99" : options.preflightChange && !writeCount ? "104.16.0.98" : row.Value,
          RecordLine: row.Line, RecordLineId: row.LineId, TTL: row.TTL, Enabled: row.Status === "ENABLE" ? 1 : 0, Remark: row.Remark } };
      } else throw new Error(`Unexpected action ${action}`);
      return Response.json({ Response: { ...result, RequestId: "request" } });
    }
    if (init.headers?.authorization) throw new Error("Credentials leaked to a public source");
    if (url.endsWith("/ips")) return options.rangeFailure ? new Response(null, { status: 503 }) : Response.json({ success: true, result: { ipv4_cidrs: ["104.16.0.0/13"] } });
    if (url.includes("v2rayssr.com")) return options.sourceFailure ? new Response(null, { status: 503 }) : new Response(v2html(options.rows));
    if (url.includes("api.hostmonit.com")) return Response.json(options.hostmonit ?? { code: 200, info: { CT: [] } });
    throw new Error(`Unexpected URL ${url}`);
  };
  return { fetcher, calls, records, sleep: async () => {}, get writeCount() { return writeCount; } };
}
function assertDomain(domain) { if (domain !== DNS_CONFIG.domain) throw new Error("Attempted another DNS zone"); }
