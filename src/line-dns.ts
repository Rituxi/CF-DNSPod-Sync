import { getJson, hostname, validateIps, type Fetcher } from "./network.ts";
import { type Line } from "./config.ts";

// Resolver ECS samples are diagnostics, not proof of nationwide ISP DNS behavior.
export const DNS_SAMPLES: { line: Line; subnet: string; description: string }[] = [
  { line: "DEFAULT", subnet: "0.0.0.0/0", description: "no-client-location" },
  { line: "CT", subnet: "202.96.128.0/24", description: "Guangdong-Telecom-ECS" },
  { line: "CU", subnet: "210.21.196.0/24", description: "Guangdong-Unicom-ECS" },
  { line: "CM", subnet: "211.136.192.0/24", description: "Guangdong-Mobile-ECS" },
];

export async function readLineDns(target: string, fetcher: Fetcher = fetch) {
  const name = hostname(target);
  return Promise.all(DNS_SAMPLES.map(async sample => {
    try {
      const query = new URL("https://dns.google/resolve");
      query.search = new URLSearchParams({ name, type: "A", edns_client_subnet: sample.subnet }).toString();
      const data = await getJson(fetcher, query.href);
      if (data.Status !== 0 || !Array.isArray(data.Answer)) throw new Error("DNS lookup failed");
      const ips = validateIps(data.Answer.filter((row: any) => row.type === 1).map((row: any) => row.data));
      const cnames = data.Answer.filter((row: any) => row.type === 5).map((row: any) => row.data);
      return { ...sample, status: "resolved" as const, ips, cnames, resolverEcs: data.edns_client_subnet ?? null };
    } catch (error) { return { ...sample, status: "failed" as const, ips: [] as string[], cnames: [] as string[],
      error: error instanceof Error ? error.message : "DNS failed" }; }
  }));
}
