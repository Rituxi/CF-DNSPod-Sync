import { readCandidates } from "./sources.ts";
import { DnsPod, validateEnv, type DnsEnv, type DnsLine, type DnsRecord } from "./dnspod.ts";
import { DNS_CONFIG, LINES, POLICY, SOURCE_CONFIG, type Line } from "./config.ts";
import { ipv4Number, type Fetcher } from "./network.ts";
import { StateStore, LeaseLostError, type LineState } from "./state.ts";
import { buildChallengers } from "./candidates.ts";
import { decideLine, type Decision } from "./selection.ts";

export function sameRecord(a: DnsRecord, b: DnsRecord): boolean {
  return ["RecordId", "Name", "Type", "Value", "Line", "LineId", "TTL", "Status", "Remark"].every(key => a[key as keyof DnsRecord] === b[key as keyof DnsRecord]);
}
export function managedRecords(records: DnsRecord[], lines: DnsLine[]): DnsRecord[] {
  if (records.some(row => ["CNAME", "AAAA", "HTTPS", "SVCB"].includes(row.Type))) throw new Error("Only the already initialized four-line A pool is supported; no legacy migration");
  return LINES.map(line => {
    const provider = lines.find(item => item.Name === line.name);
    const matches = records.filter(row => row.Type === "A" && row.LineId === provider?.LineId);
    const row = matches[0];
    if (matches.length !== 1 || row.Name !== "@" || row.Line !== line.name || row.Status !== "ENABLE" || row.TTL !== DNS_CONFIG.ttl || row.Remark !== DNS_CONFIG.owner) throw new Error(`Expected one enabled managed A with TTL 600 on ${line.name}`);
    ipv4Number(row.Value);
    return row;
  });
}
export async function synchronize(env: DnsEnv, options: {
  fetcher?: Fetcher; now?: number | (() => number); dryRun?: boolean; store?: StateStore;
  beforeApply?: (plan: unknown) => Promise<void>; sleep?: (ms: number) => Promise<void>;
  manualRankedLine?: Line;
  requireFrozen?: boolean;
} = {}) {
  validateEnv(env);
  if (env.SYNC_MODE === "paused") return { status: "paused", dnsWrites: false };
  if (!env.STATE && !options.store) throw new Error("Missing dedicated tool STATE database; ranked writes are disabled");
  const store = options.store ?? new StateStore(env.STATE!);
  const startingStateCalls = store.calls;
  const clock = typeof options.now === "function" ? options.now : options.now === undefined ? () => Date.now() : () => options.now as number;
  const now = clock();
  let networkCalls = 0;
  const fetcher: Fetcher = (url, init) => { networkCalls++; return (options.fetcher ?? fetch)(url, init); };
  const client = new DnsPod(env, fetcher);
  const claimed = options.dryRun ? null : await store.claimSyncSnapshot(now);
  const locked = claimed?.owner;
  if (!options.dryRun && !locked) return { status: "held", reason: "sync-already-running", dnsWrites: false };
  try {
    const [authority, poolResult, snapshot] = await Promise.all([
      client.inspect(), readCandidates(fetcher, now).then(value => ({ value, error: null as string | null }), error => ({ value: null, error: error instanceof Error ? error.message : "Sources failed" })),
      claimed ? claimed.snapshot : store.syncSnapshot(now),
    ]);
    const { control, lines: previous, rounds, unsettled } = snapshot;
    if (options.requireFrozen && !control.frozen) throw new Error("Frozen validation requires publication to remain frozen");
    const records = managedRecords(authority.records, authority.lines);
    const states: LineState[] = LINES.map((line, index) => {
      const record = records[index], old = previous.find(state => state.line === line.id);
      const unchanged = old && sameRecord(old.record, record) && !unsettled.some(attempt => attempt.line === line.id);
      const pool = poolResult.value;
      const sourceHealthy = !!pool?.sources.some(source => "lines" in source && source.lines?.some(item => item.line === line.id && item.accepted > 0));
      return { line: line.id, name: line.name, record, fetchedAt: now,
        version: unchanged ? old.version : crypto.randomUUID(), lastSwitchAt: unchanged ? old.lastSwitchAt : now,
        candidates: buildChallengers(line.id, record.Value, pool ?? { candidates: [] }, old?.candidates ?? [], now),
        sourceHealthy, backups: unchanged ? old.backups : [] };
    });
    const decisions: Decision[] = states.map(state => {
      if (options.manualRankedLine === state.line) {
        const ranked = poolResult.value?.selections.find(selection => selection.line === state.line)?.candidate;
        return { line: state.line, kind: ranked && ranked.ip !== state.record.Value ? "switch" : "hold",
          reason: "explicit-manual-ranked-fallback", ip: ranked?.ip ?? null, evidence: [], comparisons: [], backups: state.backups, emergency: false };
      }
      return decideLine(state, rounds, now);
    });
    for (const state of states) {
      const decision = decisions.find(decision => decision.line === state.line)!;
      state.backups = decision.backups;
      state.decision = { reason: decision.reason, ip: decision.ip, at: now, evidence: decision.evidence };
    }
    const allowed = env.SYNC_MODE === "sync" && !control.frozen;
    const plan = { at: new Date(now).toISOString(), strategy: "measured-success-rate", mode: env.SYNC_MODE,
      frozen: !!control.frozen, publicationAllowed: allowed, authorityFetchedAt: now,
      sources: poolResult.value?.sources ?? [], sourceError: poolResult.error, states, decisions };
    if (options.dryRun) return { status: "planned", ...plan, dnsWrites: false, countedSubrequests: networkCalls + store.calls - startingStateCalls };
    await store.saveLines(states, clock(), locked!, true);
    const changes = decisions.filter(decision => decision.kind === "switch");
    if (changes.length && allowed) await options.beforeApply?.(plan);
    const outcomes: { line: Line; status: string; reason: string; ip?: string; error?: string }[] = [];
    let dnsWrites = false;
    for (const decision of decisions) {
      const state = states.find(state => state.line === decision.line)!;
      if (decision.kind !== "switch" || !allowed) {
        outcomes.push({ line: state.line, status: "held", reason: control.frozen ? "publication-frozen" : env.SYNC_MODE === "observe" ? "observation-only" : decision.reason }); continue;
      }
      const id = `${state.line}:${state.version}:${decision.evidence.join(",")}:${decision.ip}`;
      let begun = false;
      const intent = { decision, from: state.record.Value, to: decision.ip, version: state.version };
      const stillEligible = () => {
        const at = clock();
        if (options.manualRankedLine === state.line) {
          const ranked = poolResult.value?.selections.find(selection => selection.line === state.line)?.candidate;
          return !!ranked && ranked.ip === decision.ip && ranked.measuredAt + SOURCE_CONFIG.maxAgeHours * 3600_000 > at && at - state.fetchedAt <= POLICY.snapshotMaxAgeMs;
        }
        const fresh = decideLine(state, rounds, at);
        return fresh.kind === "switch" && fresh.ip === decision.ip;
      };
      try {
        if (!stillEligible()) { outcomes.push({ line: state.line, status: "held", reason: "evidence-expired-before-write" }); continue; }
        const current = await client.record(state.record.RecordId);
        if (!sameRecord(current, state.record)) {
          state.record = current; state.version = crypto.randomUUID(); state.lastSwitchAt = now; state.backups = [];
          state.candidates = state.candidates.filter(candidate => candidate.ip !== current.Value);
          state.decision = { reason: "authoritative-baseline-changed", ip: null, at: now, evidence: [] };
          await store.saveLines([state], clock(), locked!);
          outcomes.push({ line: state.line, status: "held", reason: "authoritative-baseline-changed" }); continue;
        }
        if (!stillEligible()) { outcomes.push({ line: state.line, status: "held", reason: "evidence-expired-before-write" }); continue; }
        begun = await store.beginSwitch(id, state.line, clock(), intent, locked!, options.manualRankedLine === state.line ? undefined :
          { roundIds: decision.evidence, baselineVersion: state.version });
        if (!begun) { outcomes.push({ line: state.line, status: "held", reason: "publication-frozen-lease-lost-evidence-changed-or-already-attempted" }); continue; }
        if (!stillEligible()) {
          await store.finishSwitch(id, "cancelled", { ...intent, reason: "evidence-expired-before-write" });
          outcomes.push({ line: state.line, status: "held", reason: "evidence-expired-before-write" }); continue;
        }
        // A request that times out may still have reached DNSPod; report it as an attempted write.
        dnsWrites = true;
        const response = await client.call("ModifyRecord", { SubDomain: "@", RecordType: "A", RecordLine: state.name, RecordLineId: current.LineId,
          Value: decision.ip, TTL: DNS_CONFIG.ttl, Status: "ENABLE", RecordId: current.RecordId });
        if (response.RecordId !== current.RecordId) throw new Error("DNSPod write returned a different record ID");
        const expected = { ...current, Value: decision.ip! };
        let verified: DnsRecord | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(5000);
          try { const row = await client.record(current.RecordId); if (!sameRecord(row, expected)) throw new Error("DNSPod read-back differs from the decision"); verified = row; break; }
          catch (error) { if (attempt === 2) throw error; }
        }
        state.record = verified!; state.version = crypto.randomUUID(); state.lastSwitchAt = clock(); state.fetchedAt = clock();
        state.candidates = state.candidates.filter(candidate => candidate.ip !== decision.ip);
        state.backups = []; // Backup evidence belonged to the previous published baseline.
        await store.completeSwitch(id, { ...intent, verified, at: clock() }, state, clock(), locked!);
        outcomes.push({ line: state.line, status: "updated", reason: decision.reason, ip: decision.ip! });
      } catch (error) {
        const message = error instanceof Error ? error.message : "DNS write failed or unverified";
        if (begun && !(error instanceof LeaseLostError)) await store.finishSwitch(id, "failed-or-unverified", { ...intent, error: message, at: clock() });
        outcomes.push({ line: state.line, status: "failed", reason: "dns-write-not-verified", error: message });
      }
    }
    return { status: outcomes.some(outcome => outcome.status === "failed") ? "partial" : dnsWrites ? "updated" : "held",
      ...plan, outcomes, dnsWrites, countedSubrequests: networkCalls + store.calls - startingStateCalls + 1 };
  } finally { if (locked) await store.releaseSync(locked); }
}
