import { cloudflareRangeCheck, getJson, getText, ipv4Number, type Fetcher } from "./network.ts";
import { LINES, SOURCE_CONFIG, type Line } from "./config.ts";

export interface Candidate {
  ip: string; source: string; line: Line; rank: number;
  lossPercent: number; latencyMs: number; measuredAt: number;
}
export type Selection = { line: Line; name: string; candidate: Candidate | null };

export function parseChinaTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}[-/]\d{2}[-/]\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return NaN;
  const normalized = value.replaceAll("/", "-").replace(" ", "T");
  const stamp = Date.parse(`${normalized}+08:00`);
  return Number.isFinite(stamp) && new Date(stamp + 8 * 3600_000).toISOString().slice(0, 19) === normalized ? stamp : NaN;
}

export function parseV2RaySSR(html: string): Candidate[] {
  const labels: Record<string, Line> = { 多线: "DEFAULT", 通用: "DEFAULT", 电信: "CT", 联通: "CU", 移动: "CM" };
  const candidates: Candidate[] = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => cell[1].replace(/<[^>]*>/g, "").replaceAll("&nbsp;", " ").trim());
    if (cells.length !== 9 || !Object.hasOwn(labels, cells[1])) continue;
    const ip = cells[2].match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:已复制!)?$/)?.[1];
    const loss = cells[3].match(/^(\d+(?:\.\d+)?)%$/)?.[1];
    const latency = cells[4].match(/^(\d+(?:\.\d+)?)ms$/)?.[1];
    if (!ip || !loss || !latency || !/^\d+$/.test(cells[0])) continue;
    candidates.push({ ip, source: "v2rayssr", line: labels[cells[1]], rank: Number(cells[0]),
      lossPercent: Number(loss), latencyMs: Number(latency), measuredAt: parseChinaTime(cells[8]) });
  }
  if (!candidates.length) throw new Error("V2RaySSR table changed or unavailable");
  return candidates;
}

export function parseHostMonit(data: any): Candidate[] {
  if (data?.code !== 200 || !data.info || typeof data.info !== "object") throw new Error("HostMonit schema changed or unavailable");
  const candidates: Candidate[] = [];
  // CN is accepted only if the response explicitly supplies that common line.
  for (const [key, line] of Object.entries({ CT: "CT", CU: "CU", CM: "CM", CN: "DEFAULT" } as const)) {
    const rows = data.info[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) continue;
    rows.forEach((row: any, index: number) => {
      if (!row || row.line !== key) return;
      candidates.push({ ip: row.ip, source: "hostmonit", line, rank: index + 1,
        lossPercent: row.loss, latencyMs: row.latency, measuredAt: parseChinaTime(row.time) });
    });
  }
  if (!candidates.length) throw new Error("HostMonit has no recognized carrier rows");
  return candidates;
}

export function rejection(candidate: Candidate, now: number, isCloudflare: (ip: string) => boolean): string | null {
  try { ipv4Number(candidate.ip); if (!isCloudflare(candidate.ip)) return "outside-cloudflare"; }
  catch { return "invalid-ipv4"; }
  if (!Number.isFinite(candidate.measuredAt)) return "invalid-measurement-time";
  if (candidate.measuredAt > now + SOURCE_CONFIG.futureToleranceMinutes * 60_000) return "future-measurement";
  if (now - candidate.measuredAt > SOURCE_CONFIG.maxAgeHours * 3600_000) return "stale";
  if (typeof candidate.lossPercent !== "number" || !Number.isFinite(candidate.lossPercent) || candidate.lossPercent < 0 || candidate.lossPercent > SOURCE_CONFIG.maxLossPercent) return "loss";
  if (typeof candidate.latencyMs !== "number" || !Number.isFinite(candidate.latencyMs) || candidate.latencyMs <= 0 || candidate.latencyMs > SOURCE_CONFIG.maxLatencyMs) return "latency";
  if (!Number.isInteger(candidate.rank) || candidate.rank < 1) return "invalid-rank";
  return null;
}

export function selectLines(candidates: Candidate[], now: number, isCloudflare: (ip: string) => boolean): Selection[] {
  return selectAccepted(candidates.filter(row => !rejection(row, now, isCloudflare)));
}
function selectAccepted(candidates: Candidate[]): Selection[] {
  return LINES.map(line => {
    for (const source of SOURCE_CONFIG.sources.filter(source => source.enabled)) {
      const rows = candidates.filter(row => row.line === line.id && row.source === source.id)
        .sort((a, b) => a.rank - b.rank);
      if (rows.length) return { line: line.id, name: line.name, candidate: rows[0] };
    }
    return { line: line.id, name: line.name, candidate: null };
  });
}

export async function readCandidates(fetcher: Fetcher = fetch, now = Date.now()) {
  if (new Set(SOURCE_CONFIG.sources.map(source => source.id)).size !== SOURCE_CONFIG.sources.length ||
    SOURCE_CONFIG.sources.some(source => !["v2rayssr", "hostmonit"].includes(source.id)) ||
    !Number.isFinite(SOURCE_CONFIG.maxAgeHours) || SOURCE_CONFIG.maxAgeHours <= 0 ||
    !Number.isFinite(SOURCE_CONFIG.maxLossPercent) || SOURCE_CONFIG.maxLossPercent < 0 || SOURCE_CONFIG.maxLossPercent > 100 ||
    !Number.isFinite(SOURCE_CONFIG.maxLatencyMs) || SOURCE_CONFIG.maxLatencyMs <= 0) throw new Error("Invalid source configuration");
  const isCloudflare = await cloudflareRangeCheck(fetcher);
  const candidates: Candidate[] = [];
  const rejectedCandidates: (Candidate & { reason: string })[] = [];
  const sources = await Promise.all(SOURCE_CONFIG.sources.filter(source => source.enabled).map(async source => {
    try {
      const rows = source.id === "v2rayssr" ? parseV2RaySSR(await getText(fetcher, source.url)) :
        parseHostMonit(await getJson(fetcher, source.url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "o1zrmHAF", type: "v4" }) }));
      if (rows.length > 200) throw new Error("Unexpected source row count");
      // Validate every row once. Range parsing and timestamp/metric checks used to be
      // repeated for diagnostics, selections and the two candidate arrays on every Cron.
      const assessed = rows.map(row => ({ row, reason: rejection(row, now, isCloudflare) }));
      for (const { row, reason } of assessed) {
        if (reason) rejectedCandidates.push({ ...row, reason }); else candidates.push(row);
      }
      const lines = LINES.map(line => {
        const received = assessed.filter(item => item.row.line === line.id);
        const rejected: Record<string, number> = {};
        for (const { reason } of received) if (reason) rejected[reason] = (rejected[reason] ?? 0) + 1;
        const accepted = received.filter(item => !item.reason).length;
        const times = received.map(item => item.row.measuredAt).filter(Number.isFinite);
        return { line: line.id, received: received.length, accepted, rejected,
          latestMeasuredAt: times.length ? new Date(Math.max(...times)).toISOString() : null };
      });
      return { id: source.id, status: lines.some(line => line.accepted) ? "ok" : "filtered", lines };
    } catch (error) {
      return { id: source.id, status: "unavailable", error: error instanceof Error ? error.message : "Source unavailable" };
    }
  }));
  return { fetchedAt: new Date(now).toISOString(), strategy: "source-ranking-per-carrier",
    sources, selections: selectAccepted(candidates), candidates, rejectedCandidates };
}
