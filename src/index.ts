import { synchronize } from "./sync.ts";
import { type DnsEnv } from "./dnspod.ts";

export default {
  async scheduled(event: { cron: string; scheduledTime: number }, env: DnsEnv): Promise<void> {
    try {
      const result = await synchronize(env);
      const log = ["held", "pending", "partial", "migration-required"].includes(result.status) ? console.warn : console.log;
      log(JSON.stringify({ event: "dnspod-sync", cron: event.cron, scheduledTime: event.scheduledTime, ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: "dnspod-sync-failed", error: error instanceof Error ? error.message : "Sync failed; keeping existing records" }));
      throw error;
    }
  },
};
