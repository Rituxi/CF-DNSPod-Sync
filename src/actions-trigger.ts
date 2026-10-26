// A clock and one GitHub API request only. All business work stays in Actions.
export interface TriggerEnv { GITHUB_DISPATCH_TOKEN?: string; DISPATCH_ENABLED: string }
export type TriggerTask = "sync" | "probe";
const REPOSITORY = "Rituxi/CF-DNSPod-Sync";
export const TRIGGER_CRON = "3,10,25,33,40,55 * * * *";
export function dueTask(scheduledTime: number): TriggerTask | null {
  if (!Number.isFinite(scheduledTime)) throw new Error("Invalid scheduled time");
  const minute = new Date(scheduledTime).getUTCMinutes();
  return [3, 33].includes(minute) ? "sync" : [10, 25, 40, 55].includes(minute) ? "probe" : null;
}
export async function dispatchTask(env: TriggerEnv, task: TriggerTask, scheduledTime: number,
  options: { frozen?: boolean; validation?: boolean; fetcher?: typeof fetch } = {}) {
  if (!["sync", "probe"].includes(task)) throw new Error("Unsupported trigger task");
  const token = env.GITHUB_DISPATCH_TOKEN?.trim();
  if (!token) throw new Error("Missing repository-scoped GitHub Actions trigger token");
  const scheduledAt = new Date(scheduledTime).toISOString();
  const inputs = { trigger_source: options.validation ? "clock-validation" : "cloudflare-cron", scheduled_at: scheduledAt,
    ...(task === "sync" ? { mode: options.frozen ? "frozen" : "apply" } : { require_frozen: !!options.frozen }) };
  const response = await (options.fetcher ?? fetch)(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/${task}.yml/dispatches`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json",
      "x-github-api-version": "2026-03-10", "user-agent": "cf-dnspod-actions-trigger/1.0" },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error(`GitHub workflow dispatch HTTP ${response.status}; no automatic retry`); }
  const result = await response.json() as { workflow_run_id?: number; html_url?: string };
  if (!Number.isSafeInteger(result.workflow_run_id) || result.workflow_run_id! <= 0 ||
    result.html_url !== `https://github.com/${REPOSITORY}/actions/runs/${result.workflow_run_id}`) {
    throw new Error("GitHub accepted a dispatch but its run identity was not verified; no automatic retry");
  }
  return { status: "dispatched", task, scheduledAt, triggerSource: inputs.trigger_source,
    runId: result.workflow_run_id, runUrl: result.html_url, dnsWrites: false };
}
export async function onClock(event: { scheduledTime: number }, env: TriggerEnv, fetcher?: typeof fetch) {
  if (env.DISPATCH_ENABLED !== "true") return { status: "paused", dnsWrites: false };
  const task = dueTask(event.scheduledTime);
  if (!task) return { status: "held", reason: "not-a-configured-minute", dnsWrites: false };
  return dispatchTask(env, task, event.scheduledTime, { fetcher });
}
export default {
  async scheduled(event: { scheduledTime: number }, env: TriggerEnv): Promise<void> {
    console.log(JSON.stringify({ event: "actions-clock", ...await onClock(event, env) }));
  },
  async fetch(request: Request, env: TriggerEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return Response.json({ ok: true, service: "cf-dnspod-actions-trigger", enabled: env.DISPATCH_ENABLED === "true" }, { headers: { "cache-control": "no-store" } });
    if (path !== "/dispatch" || request.method !== "POST") return new Response(null, { status: 404 });
    if (!env.GITHUB_DISPATCH_TOKEN?.trim() || request.headers.get("authorization") !== `Bearer ${env.GITHUB_DISPATCH_TOKEN.trim()}`) return new Response(null, { status: 401 });
    try {
      const body = await request.json() as { task?: TriggerTask };
      if (body.task !== "sync" && body.task !== "probe") return Response.json({ error: "Choose sync or probe" }, { status: 400 });
      // An authenticated active validation always requires the existing D1 freeze.
      const result = await dispatchTask(env, body.task, Date.now(), { frozen: true, validation: true });
      console.log(JSON.stringify({ event: "actions-clock-validation", ...result }));
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dispatch failed";
      console.error(JSON.stringify({ event: "actions-clock-validation-failed", error: message }));
      return Response.json({ error: message, dnsWrites: false }, { status: 502 });
    }
  },
};
