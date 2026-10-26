export const LINES = [
  { id: "DEFAULT", name: "默认" }, { id: "CT", name: "电信" },
  { id: "CU", name: "联通" }, { id: "CM", name: "移动" },
] as const;
export type Line = typeof LINES[number]["id"];

// Array order is source priority. Keep the provider's ranking within each line.
export const SOURCE_CONFIG = {
  maxAgeHours: 6, maxLossPercent: 1, maxLatencyMs: 1000, futureToleranceMinutes: 5,
  sources: [
    { id: "v2rayssr", enabled: true, url: "https://v2rayssr.com/cfip/" },
    // Public historical example key documented by HostMonit's cf2dns project.
    { id: "hostmonit", enabled: true, url: "https://api.hostmonit.com/get_optimization_ip" },
  ],
};
export const DNS_CONFIG = {
  domain: "pick.luro.qzz.io", domainId: "100181956", subdomain: "@", ttl: 600,
  owner: "managed-by:cf-dnspod-sync",
};
export const TEST_SERVICE = "cf-ipv4-test";

export const POLICY = {
  accessBudgetMs: 10_000,
  probeTimeoutSeconds: 10, // Globalping's top-level timeout, in seconds.
  probesPerCarrier: 3,
  rotation: ["CU", "CT", "CM", "DEFAULT"] as Line[],
  maxChallengers: 2,
  shortlistPerSource: 3,
  winsRequired: 2,
  evidenceMaxAgeMs: 6 * 3600_000,
  backupMaxAgeMs: 2 * 3600_000,
  cooldownMs: 60 * 60_000,
  snapshotMaxAgeMs: 35 * 60_000,
  speedImprovementPercent: 20,
  speedImprovementMs: 100,
  retentionMs: 48 * 3600_000,
  slotMs: 15 * 60_000,
  leaseMs: 3 * 60_000,
  hourlyProbeBudget: 180, // Scheduled maximum 144; includes manual and failure rechecks.
  apiReserveTests: 18,
  initialPollWaitMs: 20_000, // Probe timeout + 10 seconds for API finalization.
  pollIntervalMs: 5_000,
  maxPollRequests: 20,
};
