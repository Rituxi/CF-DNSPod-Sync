import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DnsPod } from "../src/dnspod.ts";
import { readLineDns } from "../src/line-dns.ts";
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const credentials = JSON.parse(await readFile(new URL("../.local/dnspod-credentials.json", import.meta.url), "utf8"));
const snapshot = { at: new Date().toISOString(), dnspod: await new DnsPod({ ...config.vars, ...credentials }).inspect(),
  resolverSamples: await readLineDns(config.vars.DNSPOD_DOMAIN) };
await mkdir(new URL("../.local/", import.meta.url), { recursive: true });
await writeFile(new URL(`../.local/dns-${Date.now()}.json`, import.meta.url), JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify(snapshot, null, 2));
