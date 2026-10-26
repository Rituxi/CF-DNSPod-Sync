import { POLICY, DNS_CONFIG } from "./config.ts";
import { StateStore, LeaseLostError, type StateDatabase, type Round } from "./state.ts";
import { Globalping, measurementRequest, RateLimitError } from "./globalping.ts";
import { summarizeMeasurement, comparable, focusedSamples } from "./measurement.ts";
import { type Fetcher } from "./network.ts";
export { measurementRequest } from "./globalping.ts";
export { summarizeMeasurement, CARRIERS } from "./measurement.ts";
export interface ProbeEnv { TARGET_RECORD: string; HEALTH_URL: string; PROBE_MODE: "observe" | "paused"; STATE?: StateDatabase }
export async function runRemoteProbe(env: ProbeEnv, options: {
  fetcher?: Fetcher; sleep?: (ms: number) => Promise<void>; now?: () => number; store?: StateStore;
} = {}) {
  if (!["observe", "paused"].includes(env.PROBE_MODE) || env.TARGET_RECORD !== DNS_CONFIG.domain) throw new Error("Invalid independent probe configuration");
  if (env.PROBE_MODE === "paused") return { status: "paused", dnsWrites: false };
  measurementRequest(new URL(env.HEALTH_URL).hostname, env.HEALTH_URL);
  if (!env.STATE && !options.store) throw new Error("Missing dedicated tool STATE database");
  const store = options.store ?? new StateStore(env.STATE!);
  const startingStateCalls = store.calls;
  const now = options.now ?? (() => Date.now()), startedAt = now();
  const { control, lines: states } = await store.probeSnapshot();
  if (control.backoff_until > startedAt) return { status: "held", reason: "provider-backoff", retryAt: control.backoff_until, dnsWrites: false };
  if (control.last_probe_slot >= Math.floor(startedAt / POLICY.slotMs) || control.probe_lease_until >= startedAt) return { status: "held", reason: "round-already-claimed", dnsWrites: false };
  const line = control.priority_line && control.priority_until >= startedAt ? control.priority_line : POLICY.rotation[control.probe_cursor % POLICY.rotation.length];
  const state = states.find(state => state.line === line);
  if (!state || startedAt - state.fetchedAt > POLICY.snapshotMaxAgeMs) return { status: "held", line, reason: "authoritative-snapshot-missing-or-stale", dnsWrites: false };
  const candidates = state.candidates.filter(candidate => candidate.expiresAt > startedAt);
  const targets = [new URL(env.HEALTH_URL).hostname, ...new Set([state.record.Value, ...candidates.map(candidate => candidate.ip)])];
  if (targets.length > 4) throw new Error("Round exceeds four-target budget");
  const reserve = targets.length * 9, api = new Globalping(options.fetcher ?? fetch, now);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let allocation: Awaited<ReturnType<StateStore["claimRound"]>> = null, round: Round | null = null;
  const requireLeaseTime = () => {
    // A single remaining job can consume all 20 polls. Bound wall time as well as calls.
    if (now() + 8000 >= startedAt + POLICY.leaseMs) throw new Error("Polling stopped before the bounded probe lease expires");
  };
  try {
    const limit = await api.limits();
    if (limit.remaining < reserve + POLICY.apiReserveTests) {
      await store.backoff(limit.resetAt);
      return { status: "held", line, reason: "provider-hourly-budget-reserved", remaining: limit.remaining, required: reserve, retryAt: limit.resetAt, dnsWrites: false };
    }
    allocation = await store.claimRound(control, startedAt, reserve);
    if (!allocation) return { status: "held", line, reason: "round-duplicate-lease-or-hourly-budget", dnsWrites: false };
    round = { id: allocation.id, line: allocation.line, slot: allocation.slot, baselineVersion: state.version, currentIp: state.record.Value,
      startedAt, status: "running", candidates, reports: [], allocations: [], errors: [], requestedTests: 0 };
    await store.startRound(round, reserve);
    requireLeaseTime();
    const baseline = await api.create(targets[0], env.HEALTH_URL);
    round.allocations.push(baseline); round.requestedTests += baseline.count;
    for (const target of targets.slice(1)) {
      requireLeaseTime();
      try { const job = await api.create(target, env.HEALTH_URL, baseline); round.allocations.push(job); round.requestedTests += job.count; }
      catch (error) {
        round.errors.push({ target, error: error instanceof Error ? error.message : "Create failed" });
        if (error instanceof RateLimitError) { await store.backoff(error.retryAt); break; }
      }
    }
    await store.saveRound(round, allocation.owner, now());
    const jobs = round.allocations.map(job => ({ ...job, etag: undefined as string | undefined }));
    let remaining = POLICY.maxPollRequests;
    for (let iteration = 0; jobs.length && remaining >= jobs.length; iteration++) {
      await sleep(iteration === 0 ? POLICY.initialPollWaitMs : POLICY.pollIntervalMs);
      requireLeaseTime();
      remaining -= jobs.length;
      const updates = await Promise.allSettled(jobs.map(async job => ({ job, response: await api.request(`/measurements/${job.id}`, {}, job.etag) })));
      let limited = false;
      for (let index = updates.length - 1; index >= 0; index--) {
        const update = updates[index];
        if (update.status === "rejected") {
          round.errors.push({ target: jobs[index].target, error: update.reason instanceof Error ? update.reason.message : "Poll failed" });
          if (update.reason instanceof RateLimitError) { await store.backoff(update.reason.retryAt); limited = true; }
          jobs.splice(index, 1); continue;
        }
        const { job, response } = update.value; jobs[index].etag = response.etag;
        if (response.notModified || response.data.status === "in-progress") continue;
        if (response.data.id !== job.id || response.data.target !== job.target) round.errors.push({ target: job.target, error: "Measurement identity mismatch" });
        else {
          try { round.reports.push(summarizeMeasurement(response.data, job.count)); }
          catch (error) { round.errors.push({ target: job.target, error: error instanceof Error ? error.message : "Invalid result" }); }
        }
        jobs.splice(index, 1);
      }
      if (jobs.length && updates.some(update => update.status === "rejected" || (!update.value.response.notModified && update.value.response.data.status !== "in-progress"))) {
        // Persist completed first results while another job is still pending.
        await store.saveRound(round, allocation.owner, now());
      }
      if (limited) break;
    }
    jobs.forEach(job => round!.errors.push({ target: job.target, error: "Result pending after bounded polling; not a target failure" }));
    const baselineReport = round.reports.find(report => report.target === targets[0]), currentReport = round.reports.find(report => report.target === state.record.Value);
    const validForLine = !round.errors.length && round.reports.length === targets.length && !!baselineReport && !!currentReport &&
      round.reports.every(report => comparable([baselineReport, currentReport, report], line).ok);
    round.status = validForLine ? "measured" : "partial"; round.completedAt = now(); round.apiCalls = api.calls;
    await store.saveRound(round, allocation.owner, now());
    if (validForLine && currentReport && baselineReport && comparable([baselineReport, currentReport, currentReport], line).ok) {
      const rows = focusedSamples(currentReport, line);
      if (rows.filter(row => !row.ok).length > rows.length / 2) {
        const previous = (await store.latestRounds(startedAt)).find(previous => previous.id !== round!.id && previous.line === line && previous.baselineVersion === state.version);
        const report = previous?.reports.find(report => report.target === state.record.Value);
        if (!report || focusedSamples(report, line).filter(row => !row.ok).length <= focusedSamples(report, line).length / 2) await store.prioritize(line, startedAt);
      }
    }
    return { ...round, healthUrl: env.HEALTH_URL, scope: "same-round-public-metadata-cohort", validForLine,
      stableProbeIdsAvailable: false, stateCalls: store.calls - startingStateCalls + 1, countedSubrequests: api.calls + store.calls - startingStateCalls + 1, dnsWrites: false };
  } catch (error) {
    if (error instanceof RateLimitError) await store.backoff(error.retryAt);
    if (round) {
      round.status = "partial"; round.completedAt = now(); round.errors.push({ target: "measurement-system", error: error instanceof Error ? error.message : "Collection failed" });
      if (!(error instanceof LeaseLostError)) {
        try { await store.saveRound(round, allocation!.owner, now()); }
        catch (saveError) { if (!(saveError instanceof LeaseLostError)) throw saveError; }
      }
      return { ...round, apiCalls: api.calls, stateCalls: store.calls - startingStateCalls + 1,
        countedSubrequests: api.calls + store.calls - startingStateCalls + 1, dnsWrites: false };
    }
    if (error instanceof RateLimitError) return { status: "held", line, reason: "provider-rate-limit", retryAt: error.retryAt, dnsWrites: false };
    throw error;
  } finally { if (allocation) await store.releaseProbe(allocation.owner); }
}
