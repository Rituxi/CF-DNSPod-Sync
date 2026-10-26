import { POLICY, SOURCE_CONFIG, type Line } from "./config.ts";
import { type Candidate } from "./sources.ts";
import { type Challenger } from "./state.ts";

export function buildChallengers(line: Line, currentIp: string, pool: {
  candidates: Candidate[];
  rejectedCandidates?: { ip: string; line: Line; measuredAt: number; reason: string }[];
}, previous: Challenger[], now: number): Challenger[] {
  const accepted = pool.candidates.filter(row => row.line === line);
  const invalidated = (row: Candidate) => pool.rejectedCandidates?.some(rejected =>
    rejected.line === line && rejected.ip === row.ip && Number.isFinite(rejected.measuredAt) && rejected.measuredAt >= row.measuredAt);
  const refresh = (row: Candidate) => accepted.filter(candidate => candidate.ip === row.ip && candidate.source === row.source && candidate.measuredAt >= row.measuredAt)
    .sort((a, b) => b.measuredAt - a.measuredAt)[0] ?? row;
  // Refresh before invalidation: a still-retained IP can have newer good evidence
  // than a bad report, even when its current rank has fallen below the shortlist.
  const retained = previous.map(row => {
    const refreshed = refresh(row);
    return { ...refreshed, expiresAt: refreshed === row ? row.expiresAt : refreshed.measuredAt + SOURCE_CONFIG.maxAgeHours * 3600_000 };
  }).filter(row => row.ip !== currentIp && row.expiresAt > now &&
    !invalidated(row));
  const shortlist: Candidate[] = [];
  for (const source of SOURCE_CONFIG.sources.filter(source => source.enabled)) {
    const unique = new Set<string>();
    for (const row of accepted.filter(row => row.source === source.id).sort((a, b) => a.rank - b.rank)) {
      if (unique.has(row.ip) || invalidated(row)) continue;
      unique.add(row.ip);
      if (unique.size > POLICY.shortlistPerSource) break;
      if (!shortlist.some(item => item.ip === row.ip)) shortlist.push(row);
    }
  }
  const selected = new Map<string, Challenger>();
  for (const row of [...retained, ...shortlist]) {
    if (row.ip === currentIp || selected.has(row.ip)) continue;
    const refreshed = refresh(row);
    const expiresAt = refreshed.measuredAt + SOURCE_CONFIG.maxAgeHours * 3600_000;
    if (expiresAt <= now) continue;
    selected.set(row.ip, { ...refreshed, expiresAt });
    if (selected.size === POLICY.maxChallengers) break;
  }
  return [...selected.values()];
}
