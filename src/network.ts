export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function hostname(value: string): string {
  const name = value.trim().toLowerCase().replace(/\.$/, "");
  if (name.length > 253 || !name.includes(".") || name.split(".").some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Expected a DNS hostname, without https:// or a path");
  }
  return name;
}

export function ipv4Number(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255)) {
    throw new Error("Upstream returned an invalid IPv4 address");
  }
  return parts.reduce((n, part) => n * 256 + Number(part), 0);
}

export function validateIps(ips: string[]): string[] {
  const unique = [...new Set(ips)];
  if (!unique.length || unique.length > 50) throw new Error("Expected 1-50 upstream IPv4 addresses; keeping existing DNS");
  unique.forEach(ipv4Number);
  return unique.sort((a, b) => ipv4Number(a) - ipv4Number(b));
}

export async function readLimitedText(response: Response, label: string): Promise<string> {
  if (!response.body) throw new Error(`Empty response from ${label}`);
  // Source and measurement collection now runs only in Node. Bound actual
  // decompressed bytes and decode once so fragmented Chinese text stays intact.
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error(`${label} response exceeds 1 MiB`);
      chunks.push(value);
    }
    if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
    // Decode once: provider pages and reports can arrive in many small network chunks.
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } finally {
    await reader.cancel();
  }
}

export async function getText(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<string> {
  // Never forward API credentials to a redirect target.
  const response = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return readLimitedText(response, new URL(url).hostname);
}

export async function getJson(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<any> {
  const text = await getText(fetcher, url, init);
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${new URL(url).hostname}`); }
}

export async function cloudflareRangeCheck(fetcher: Fetcher): Promise<(ip: string) => boolean> {
  const data = await getJson(fetcher, "https://api.cloudflare.com/client/v4/ips");
  const ranges: string[] = data.result?.ipv4_cidrs;
  if (data.success !== true || !Array.isArray(ranges) || !ranges.length) {
    throw new Error("Could not verify Cloudflare's published IPv4 ranges; keeping existing DNS");
  }
  const blocks = ranges.map(cidr => {
    const [base, prefix, extra] = cidr.split("/");
    if (extra !== undefined || !/^\d{1,2}$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > 32) {
      throw new Error("Invalid published IPv4 range");
    }
    const size = 2 ** (32 - Number(prefix));
    return { start: Math.floor(ipv4Number(base) / size) * size, size };
  });
  return ip => {
    const value = ipv4Number(ip);
    return blocks.some(({ start, size }) => value >= start && value < start + size);
  };
}
