import { POLICY, type Line } from "./config.ts";
import { comparable, focusedSamples, p95, CARRIERS } from "./measurement.ts";
import { type LineState, type DecisionRound, type Challenger, type Backup } from "./state.ts";

export interface Comparison {
  roundId: string; sampledAt: number; eligible: boolean; reason: string;
  currentFailed: number; candidateFailed: number; samples: number;
  currentP95: number | null; candidateP95: number | null;
  defaultCarrierGuard: boolean;
}
export function compareRound(round: DecisionRound, line: Line, candidateIp: string): Comparison {
  const base: Comparison = { roundId: round.id, sampledAt: round.startedAt, eligible: false, reason: "missing-measurement",
    currentFailed: 0, candidateFailed: 0, samples: 0, currentP95: null, candidateP95: null, defaultCarrierGuard: false };
  if (round.status !== "measured") return { ...base, reason: "round-collection-incomplete" };
  const current = round.reports.find(report => report.target === round.currentIp);
  const challenger = round.reports.find(report => report.target === candidateIp);
  const baseline = round.reports.find(report => report.target === "probe.luro.qzz.io");
  if (!current || !challenger || !baseline || !round.completedAt || round.errors.length) return base;
  const coverage = comparable([baseline, current, challenger], line);
  if (!coverage.ok) return { ...base, reason: coverage.reason };
  const currentRows = focusedSamples(current, line), candidateRows = focusedSamples(challenger, line);
  const defaultCarrierGuard = line !== "DEFAULT" || CARRIERS.every(carrier =>
    candidateRows.filter(row => row.asn === carrier.asn && !row.ok).length <= currentRows.filter(row => row.asn === carrier.asn && !row.ok).length);
  return { ...base, eligible: true, reason: coverage.reason,
    currentFailed: currentRows.filter(row => !row.ok).length, candidateFailed: candidateRows.filter(row => !row.ok).length,
    samples: currentRows.length, currentP95: p95(currentRows.filter(row => row.ok).map(row => row.totalMs!)),
    candidateP95: p95(candidateRows.filter(row => row.ok).map(row => row.totalMs!)), defaultCarrierGuard };
}

export interface Decision {
  line: Line; kind: "hold" | "switch"; reason: string; ip: string | null;
  evidence: string[]; comparisons: Comparison[]; backups: Backup[]; emergency: boolean;
}
export function decideLine(state: LineState, rounds: DecisionRound[], now: number): Decision {
  const previousBackups = state.backups.filter(backup => backup.baselineVersion === state.version && backup.ip !== state.record.Value && now - backup.verifiedAt <= POLICY.backupMaxAgeMs && state.candidates.some(candidate => candidate.ip === backup.ip && candidate.expiresAt > now));
  const base: Decision = { line: state.line, kind: "hold", reason: "no-comparable-evidence", ip: null, evidence: [], comparisons: [], backups: previousBackups, emergency: false };
  if (now - state.fetchedAt > POLICY.snapshotMaxAgeMs) return { ...base, reason: "authoritative-snapshot-stale" };
  if (!state.sourceHealthy) return { ...base, reason: "source-unavailable-hold-current" };
  const ordered = [...new Map(rounds.filter(round => round.line === state.line && round.baselineVersion === state.version &&
    round.currentIp === state.record.Value && round.startedAt <= now && now - round.startedAt <= POLICY.evidenceMaxAgeMs)
    .sort((a, b) => b.startedAt - a.startedAt).map(round => [round.id, round])).values()].slice(0, POLICY.winsRequired);
  const usable = state.candidates.filter(candidate => candidate.expiresAt > now && candidate.ip !== state.record.Value);
  if (!usable.length) return { ...base, reason: "no-fresh-challenger" };
  const wins: { candidate: Challenger; comparisons: Comparison[]; reason: string; emergency: boolean }[] = [];
  const backups: Backup[] = [...previousBackups];
  let diagnostics: Comparison[] = [];
  for (const candidate of usable) {
    const comparisons = ordered.map(round => compareRound(round, state.line, candidate.ip));
    if (!diagnostics.length) diagnostics = comparisons;
    if (comparisons.length < POLICY.winsRequired || comparisons.some(comparison => !comparison.eligible) || new Set(ordered.map(round => round.slot)).size !== POLICY.winsRequired) continue;
    const verified = comparisons.every(comparison => comparison.candidateFailed === 0) && now - comparisons[0].sampledAt <= POLICY.backupMaxAgeMs;
    if (verified) {
      const previous = backups.findIndex(backup => backup.ip === candidate.ip); if (previous >= 0) backups.splice(previous, 1);
      backups.push({ ip: candidate.ip, verifiedAt: comparisons[0].sampledAt, roundIds: comparisons.map(comparison => comparison.roundId), baselineVersion: state.version });
    }
    const guard = comparisons.every(comparison => comparison.defaultCarrierGuard);
    const fewerFailures = guard && comparisons.every(comparison => comparison.candidateFailed < comparison.currentFailed);
    const fasterNoFailures = guard && comparisons.every(comparison => comparison.currentFailed === 0 && comparison.candidateFailed === 0 &&
      comparison.currentP95 !== null && comparison.candidateP95 !== null && comparison.currentP95 - comparison.candidateP95 >= POLICY.speedImprovementMs &&
      comparison.candidateP95 <= comparison.currentP95 * (1 - POLICY.speedImprovementPercent / 100));
    const emergency = verified && fewerFailures && comparisons.every(comparison => comparison.currentFailed > comparison.samples / 2);
    if (fewerFailures || fasterNoFailures) wins.push({ candidate, comparisons, reason: emergency ? "verified-backup-majority-failure" : fewerFailures ? "fewer-failures-two-rounds" : "faster-zero-failure-two-rounds", emergency });
  }
  if (!wins.length) {
    const reason = ordered.length < POLICY.winsRequired ? "need-two-distinct-rounds" :
      diagnostics.some(comparison => !comparison.eligible) ? diagnostics.find(comparison => !comparison.eligible)!.reason : "no-consistent-improvement-hold-current";
    return { ...base, reason, comparisons: diagnostics, backups };
  }
  wins.sort((a, b) => Number(b.emergency) - Number(a.emergency) ||
    a.comparisons.reduce((sum, row) => sum + row.candidateFailed, 0) - b.comparisons.reduce((sum, row) => sum + row.candidateFailed, 0) ||
    a.comparisons[0].candidateFailed - b.comparisons[0].candidateFailed ||
    (a.comparisons[0].candidateP95 ?? Infinity) - (b.comparisons[0].candidateP95 ?? Infinity));
  const best = wins[0];
  if (now - state.lastSwitchAt < POLICY.cooldownMs && !best.emergency) return { ...base, reason: "cooldown-60-minutes", comparisons: best.comparisons, backups };
  return { ...base, kind: "switch", reason: best.reason, ip: best.candidate.ip, emergency: best.emergency,
    evidence: best.comparisons.map(comparison => comparison.roundId), comparisons: best.comparisons, backups };
}
