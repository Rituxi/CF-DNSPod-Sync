import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const mode = process.env.RUN_MODE || "apply";
const flag = { observe: "--observe", plan: "--plan", frozen: "--apply", apply: "--apply" }[mode];
if (!flag) throw new Error("Unsupported Actions sync mode");
const child = spawn(process.execPath, [fileURLToPath(new URL("../run.mjs", import.meta.url)), flag], {
  stdio: "inherit", windowsHide: true,
  env: { ...process.env, REQUIRE_PUBLICATION_FROZEN: String(mode === "frozen") },
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
