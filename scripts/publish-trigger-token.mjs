import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { cfRequest, ACCOUNT } from "./cloudflare-api.mjs";
import { requestDispatch } from "../src/actions-trigger.ts";
export async function publishTriggerToken(token, { request = cfRequest, fetcher = fetch, accountId = ACCOUNT } = {}) {
  if (!token.startsWith("github_pat_") || !/^[a-f0-9]{32}$/.test(accountId)) throw new Error("Configure the tool account and a repository-scoped fine-grained token first");
  // Prove Actions write access with a read-only plan before replacing the working clock secret.
  const check = await requestDispatch(token, "sync", { mode: "plan", trigger_source: "manual", scheduled_at: new Date().toISOString() }, fetcher);
  await request(`/accounts/${accountId}/workers/scripts/cf-dnspod-actions-trigger/secrets`, {
    method: "PUT", body: { name: "GITHUB_DISPATCH_TOKEN", text: token, type: "secret_text" },
  });
  return check;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? new URL("../.local/github-actions-trigger-token.txt", import.meta.url);
  const token = (await readFile(file, "utf8")).trim();
  const check = await publishTriggerToken(token);
  console.log("Updated the tool clock's encrypted GitHub trigger secret; token was not printed.");
  console.log(`Read-only permission check: ${check.runUrl}`);
}
