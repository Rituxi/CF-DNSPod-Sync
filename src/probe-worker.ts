import { runRemoteProbe, type ProbeEnv } from "./remote-probe.ts";
export default {
  async scheduled(event: { cron: string; scheduledTime: number }, env: ProbeEnv): Promise<void> {
    try {
      const result = await runRemoteProbe(env);
      (result.status === "partial" ? console.warn : console.log)(JSON.stringify({ event: "independent-carrier-probe", cron: event.cron, scheduledTime: event.scheduledTime, ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: "independent-carrier-probe-failed", error: error instanceof Error ? error.message : "Probe failed" }));
      throw error;
    }
  },
};
