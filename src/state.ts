import { POLICY, type Line } from "./config.ts";
import { type Candidate } from "./sources.ts";
import { type DnsRecord } from "./dnspod.ts";
import { COMPARISON_SAMPLE_KEYS, type Measurement, type ComparisonMeasurement } from "./measurement.ts";

export interface DbResult { results?: any[]; success?: boolean; meta?: { changes?: number } }
export interface DbStatement {
  bind(...values: any[]): DbStatement;
  all(): Promise<DbResult>;
  run(): Promise<DbResult>;
}
export interface StateDatabase { prepare(sql: string): DbStatement; batch(statements: DbStatement[]): Promise<DbResult[]> }
export interface Challenger extends Candidate { expiresAt: number }
export interface Backup { ip: string; verifiedAt: number; roundIds: string[]; baselineVersion: string }
export interface LineState {
  line: Line; name: string; version: string; fetchedAt: number; record: DnsRecord;
  candidates: Challenger[]; sourceHealthy: boolean; lastSwitchAt: number;
  backups: Backup[]; decision?: { reason: string; ip: string | null; at: number; evidence: string[] };
}
export interface Round {
  id: string; slot: number; line: Line; baselineVersion: string; currentIp: string;
  startedAt: number; completedAt?: number; status: "running" | "measured" | "partial";
  candidates: Challenger[]; reports: Measurement[];
  allocations: { target: string; id: string; count: number; reportUrl: string }[];
  errors: { target: string; error: string }[];
  requestedTests: number; apiCalls?: number;
}
const DECISION_ROUND_KEYS = [
  "id", "slot", "line", "baselineVersion", "currentIp", "startedAt", "completedAt", "status", "errors",
] as const;
export type DecisionRound = Pick<Round, Exclude<typeof DECISION_ROUND_KEYS[number], "completedAt">> & {
  completedAt?: number | null; reports: ComparisonMeasurement[];
};
export interface SyncSnapshot { control: Control; lines: LineState[]; rounds: DecisionRound[]; unsettled: { id: string; line: Line }[] }
export interface Control {
  frozen: number; frozen_at: number; probe_cursor: number; last_probe_slot: number;
  probe_lease_until: number; sync_lease_until: number; backoff_until: number;
  priority_line: Line | null; priority_until: number;
  sync_owner: string | null; probe_owner: string | null;
}
export class LeaseLostError extends Error {
  constructor() { super("Tool state lease expired or belongs to another invocation"); }
}

const latestRoundsSql = (projection: string) => `SELECT ${projection} FROM (
  SELECT body,started_at,ROW_NUMBER() OVER (PARTITION BY line ORDER BY started_at DESC) position
  FROM probe_rounds WHERE started_at>=?
) WHERE position<=? ORDER BY started_at DESC`;
const LATEST_ROUNDS_SQL = latestRoundsSql("body");
// D1's binding otherwise transports escaped full JSON, then parses it a second
// time in the caller. Project only the comparison view on the database side;
// persisted reports and the full diagnostic readers are unchanged.
const jsonFields = (value: string, keys: readonly string[]) => keys.map(key =>
  `'${key}',${key === "ok" ? `json(${value} -> '$.${key}')` : `json_extract(${value},'$.${key}')`}`).join(",");
const DECISION_ROUNDS_SQL = latestRoundsSql(`json_object(${jsonFields("body", DECISION_ROUND_KEYS)},
  'reports',(SELECT json_group_array(json_object(${jsonFields("r.value", ["target", "allocated"])},
    'results',(SELECT json_group_array(json_object(${jsonFields("s.value", COMPARISON_SAMPLE_KEYS)}))
      FROM json_each(r.value,'$.results') s))) FROM json_each(body,'$.reports') r)) body`);
const UNSETTLED_SWITCHES_SQL = `SELECT h.id,h.line FROM switch_history h JOIN line_state l ON l.line=h.line
  WHERE h.status IN ('attempting','failed-or-unverified','cancelled')
  AND substr(h.id,1,length(l.line||':'||json_extract(l.body,'$.version')||':'))=l.line||':'||json_extract(l.body,'$.version')||':'`;

export class StateStore {
  readonly db: StateDatabase;
  calls = 0;
  constructor(db: StateDatabase) { this.db = db; }
  private async query(sql: string, values: any[] = []): Promise<any[]> {
    this.calls++;
    const result = await this.db.prepare(sql).bind(...values).all();
    if (result.success === false) throw new Error("Tool state query failed");
    return result.results ?? [];
  }
  private async batch(statements: [string, any[]][]) {
    this.calls++;
    const results = await this.db.batch(statements.map(([sql, values]) => this.db.prepare(sql).bind(...values)));
    if (results.some(result => result.success === false)) throw new Error("Tool state transaction failed");
    return results;
  }
  async control(): Promise<Control> {
    const rows = await this.query("SELECT * FROM tool_control WHERE id=1");
    if (rows.length !== 1) throw new Error("Tool state schema not initialized");
    return rows[0];
  }
  async freeze(frozen: boolean, now: number) {
    // An already-sent DNS request may still finish. Start the TTL window after its lease,
    // so freeze never promises that an in-flight request has been cancelled at DNSPod.
    await this.query("UPDATE tool_control SET frozen=?, frozen_at=CASE WHEN ? THEN MAX(?,sync_lease_until) ELSE ? END WHERE id=1 RETURNING id", [Number(frozen), Number(frozen), now, now]);
  }
  async lines(): Promise<LineState[]> {
    return (await this.query("SELECT body FROM line_state ORDER BY line")).map(row => JSON.parse(row.body));
  }
  async probeSnapshot(): Promise<{ control: Control; lines: LineState[] }> {
    const [control, lines] = await this.batch([
      ["SELECT * FROM tool_control WHERE id=1", []],
      ["SELECT body FROM line_state ORDER BY line", []],
    ]);
    if (control.results?.length !== 1) throw new Error("Tool state schema not initialized");
    return { control: control.results[0], lines: (lines.results ?? []).map(row => JSON.parse(row.body)) };
  }
  private syncStatements(now: number): [string, any[]][] {
    // Read all decision inputs in one transaction, including incomplete rounds
    // that break streaks. Full per-probe diagnostics stay in probe_rounds.
    return [
      ["SELECT * FROM tool_control WHERE id=1", []],
      ["SELECT body FROM line_state ORDER BY line", []],
      [DECISION_ROUNDS_SQL, [now - POLICY.evidenceMaxAgeMs, POLICY.winsRequired]],
      [UNSETTLED_SWITCHES_SQL, []],
    ];
  }
  private syncResult([control, lines, rounds, unsettled]: DbResult[]): SyncSnapshot {
    if (control.results?.length !== 1) throw new Error("Tool state schema not initialized");
    return { control: control.results[0], lines: (lines.results ?? []).map(row => JSON.parse(row.body)),
      rounds: (rounds.results ?? []).map(row => JSON.parse(row.body)), unsettled: unsettled.results ?? [] };
  }
  async syncSnapshot(now: number): Promise<SyncSnapshot> { return this.syncResult(await this.batch(this.syncStatements(now))); }
  async claimSyncSnapshot(now: number): Promise<{ owner: string; snapshot: SyncSnapshot } | null> {
    const owner = crypto.randomUUID();
    const [claim, ...snapshot] = await this.batch([
      ["UPDATE tool_control SET sync_lease_until=?,sync_owner=? WHERE id=1 AND sync_lease_until<? RETURNING id", [now + POLICY.leaseMs, owner, now]],
      ...this.syncStatements(now),
    ]);
    if (!claim.results?.length) return null;
    try { return { owner, snapshot: this.syncResult(snapshot) }; }
    catch (error) { await this.releaseSync(owner); throw error; }
  }
  private lineStatement(line: LineState, now: number, owner?: string): [string, any[]] {
    return [`INSERT INTO line_state(line,body,updated_at) SELECT ?,?,?
      WHERE ? IS NULL OR EXISTS(SELECT 1 FROM tool_control WHERE id=1 AND sync_owner=? AND sync_lease_until>?)
      ON CONFLICT(line) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at RETURNING line`,
      [line.line, JSON.stringify(line), now, owner ?? null, owner ?? null, now]];
  }
  async saveLines(lines: LineState[], now: number, owner?: string, pruneExpired = false) {
    const statements = lines.map(line => this.lineStatement(line, now, owner));
    if (pruneExpired) for (const [table, column] of [["probe_rounds", "started_at"], ["switch_history", "at"]]) {
      statements.push([`DELETE FROM ${table} WHERE ${column}<? AND (? IS NULL OR
        EXISTS(SELECT 1 FROM tool_control WHERE id=1 AND sync_owner=? AND sync_lease_until>?))`,
        [now - POLICY.retentionMs, owner ?? null, owner ?? null, now]]);
    }
    const results = await this.batch(statements);
    if (results.slice(0, lines.length).some(result => result.results?.length !== 1)) throw new LeaseLostError();
  }
  async rounds(now: number): Promise<Round[]> {
    return (await this.query("SELECT body FROM probe_rounds WHERE started_at>=? ORDER BY started_at DESC LIMIT 100", [now - POLICY.evidenceMaxAgeMs]))
      .map(row => JSON.parse(row.body));
  }
  async latestRounds(now: number): Promise<Round[]> {
    // Decisions need the latest two rounds per line, including partial rounds that break a streak.
    // Filter in D1 so every Cron does not parse six hours of full per-probe diagnostics.
    return (await this.query(LATEST_ROUNDS_SQL, [now - POLICY.evidenceMaxAgeMs, POLICY.winsRequired]))
      .map(row => JSON.parse(row.body));
  }
  async claimSync(now: number): Promise<string | null> {
    const owner = crypto.randomUUID();
    const rows = await this.query("UPDATE tool_control SET sync_lease_until=?,sync_owner=? WHERE id=1 AND sync_lease_until<? RETURNING id", [now + POLICY.leaseMs, owner, now]);
    return rows.length ? owner : null;
  }
  async releaseSync(owner: string) { await this.query("UPDATE tool_control SET sync_lease_until=0,sync_owner=NULL WHERE id=1 AND sync_owner=? RETURNING id", [owner]); }
  async claimRound(control: Control, now: number, reserve: number): Promise<{ id: string; line: Line; slot: number; owner: string } | null> {
    const slot = Math.floor(now / POLICY.slotMs);
    const owner = crypto.randomUUID();
    const priority = control.priority_line && control.priority_until >= now;
    const line = priority ? control.priority_line! : POLICY.rotation[control.probe_cursor % POLICY.rotation.length];
    const rows = await this.query(`UPDATE tool_control SET probe_cursor=probe_cursor+?,last_probe_slot=?,probe_lease_until=?,probe_owner=?,priority_line=NULL,priority_until=0
      WHERE id=1 AND probe_cursor=? AND priority_line IS ? AND priority_until=? AND last_probe_slot<? AND probe_lease_until<? AND backoff_until<=?
      AND (SELECT COALESCE(SUM(reserved_tests),0) FROM probe_rounds WHERE started_at>?) + ? <= ? RETURNING id`,
      [priority ? 0 : 1, slot, now + POLICY.leaseMs, owner, control.probe_cursor, control.priority_line, control.priority_until, slot, now, now, now - 3600_000, reserve, POLICY.hourlyProbeBudget]);
    return rows.length ? { id: `v2:${slot}:${line}`, line, slot, owner } : null;
  }
  async startRound(round: Round, reserve: number) {
    const rows = await this.query("INSERT OR IGNORE INTO probe_rounds(id,line,baseline_version,started_at,reserved_tests,status,body) VALUES(?,?,?,?,?,?,?) RETURNING id",
      [round.id, round.line, round.baselineVersion, round.startedAt, reserve, round.status, JSON.stringify(round)]);
    if (rows.length !== 1) throw new Error("Round already exists; duplicate delivery must not create tests");
  }
  async saveRound(round: Round, owner?: string, now = round.completedAt ?? round.startedAt) {
    const rows = await this.query(`UPDATE probe_rounds SET completed_at=?,status=?,body=? WHERE id=?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM tool_control WHERE id=1 AND probe_owner=? AND probe_lease_until>?)) RETURNING id`,
      [round.completedAt ?? null, round.status, JSON.stringify(round), round.id, owner ?? null, owner ?? null, now]);
    if (rows.length !== 1) throw new LeaseLostError();
  }
  async releaseProbe(owner: string) { await this.query("UPDATE tool_control SET probe_lease_until=0,probe_owner=NULL WHERE id=1 AND probe_owner=? RETURNING id", [owner]); }
  async backoff(until: number) {
    await this.query("UPDATE tool_control SET backoff_until=MAX(backoff_until,?) WHERE id=1 RETURNING id", [until]);
  }
  async prioritize(line: Line, now: number) {
    await this.query("UPDATE tool_control SET priority_line=?,priority_until=? WHERE id=1 RETURNING id", [line, now + 30 * 60_000]);
  }
  async unsettledSwitches(): Promise<{ id: string; line: Line }[]> {
    // Recover even when a process died after DNSPod accepted a write but before D1 was saved.
    // Cancelled attempts from the previous implementation must not poison resume either.
    return this.query(UNSETTLED_SWITCHES_SQL);
  }
  async beginSwitch(id: string, line: Line, now: number, body: unknown, owner: string,
    evidence: { roundIds: string[]; baselineVersion: string }): Promise<boolean> {
    if (!evidence || evidence.roundIds.length !== POLICY.winsRequired || new Set(evidence.roundIds).size !== POLICY.winsRequired) return false;
    const roundIds = JSON.stringify(evidence.roundIds);
    // Probe writes have a different lease. Check the latest complete pair at the
    // same atomic point as freeze/ownership and intent, rather than trusting a
    // report snapshot captured before asynchronous DNS/source reads.
    const results = await this.batch([
      ["UPDATE tool_control SET sync_lease_until=? WHERE id=1 AND sync_owner=? AND sync_lease_until>? AND frozen=0 RETURNING id", [now + POLICY.leaseMs, owner, now]],
      [`INSERT OR IGNORE INTO switch_history(id,line,at,status,body) SELECT ?,?,?,'attempting',?
        WHERE EXISTS(SELECT 1 FROM tool_control WHERE id=1 AND sync_owner=? AND sync_lease_until>? AND frozen=0)
        AND (
          SELECT json_group_array(CASE WHEN status='measured' AND completed_at<=? AND baseline_version=? THEN id ELSE NULL END)
          FROM (SELECT id,status,completed_at,baseline_version FROM probe_rounds
            WHERE line=? AND started_at>=? ORDER BY started_at DESC LIMIT ?)
        )=? RETURNING id`,
        [id, line, now, JSON.stringify(body), owner, now, now, evidence.baselineVersion,
          line, now - POLICY.evidenceMaxAgeMs, POLICY.winsRequired, roundIds]],
    ]);
    return results[1].results?.length === 1;
  }
  async finishSwitch(id: string, status: string, body: unknown) {
    await this.query("UPDATE switch_history SET status=?,body=? WHERE id=? RETURNING id", [status, JSON.stringify(body), id]);
  }
  async completeSwitch(id: string, body: unknown, state: LineState, now: number, owner: string) {
    const results = await this.batch([
      ["UPDATE switch_history SET status='verified',body=? WHERE id=? AND EXISTS(SELECT 1 FROM tool_control WHERE id=1 AND sync_owner=? AND sync_lease_until>?) RETURNING id", [JSON.stringify(body), id, owner, now]],
      this.lineStatement(state, now, owner),
    ]);
    if (results.some(result => result.results?.length !== 1)) throw new LeaseLostError();
  }
  async prune(now: number) {
    await this.batch([
      ["DELETE FROM probe_rounds WHERE started_at<?", [now - POLICY.retentionMs]],
      ["DELETE FROM switch_history WHERE at<?", [now - POLICY.retentionMs]],
    ]);
  }
}
