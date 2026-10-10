import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["--experimental-sqlite", "--import", "tsx", "server/worker/main.ts"],
  { env: { ...process.env, CAPY_WORKER: "1" }, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
