import { readFile } from "node:fs/promises";
import { cfRequest, ACCOUNT } from "./cloudflare-api.mjs";
const file = process.argv[2] ?? new URL("../.local/github-actions-trigger-token.txt", import.meta.url);
const token = (await readFile(file, "utf8")).trim();
if (!token.startsWith("github_pat_") || !/^[a-f0-9]{32}$/.test(ACCOUNT)) throw new Error("Configure the tool account and a repository-scoped fine-grained token first");
await cfRequest(`/accounts/${ACCOUNT}/workers/scripts/cf-dnspod-actions-trigger/secrets`, {
  method: "PUT", body: { name: "GITHUB_DISPATCH_TOKEN", text: token, type: "secret_text" },
});
console.log("Updated the tool clock's encrypted GitHub trigger secret; token was not printed.");
