import { cfRequest, ACCOUNT } from "./cloudflare-api.mjs";
const workers = await Promise.all(["cf-dnspod-actions-trigger", "cf-ipv4-test"].map(async name => ({ name,
  schedules: await cfRequest(`/accounts/${ACCOUNT}/workers/scripts/${name}/schedules`),
  deployments: await cfRequest(`/accounts/${ACCOUNT}/workers/scripts/${name}/deployments`),
})));
console.log(JSON.stringify({ at: new Date().toISOString(), workers }, null, 2));
