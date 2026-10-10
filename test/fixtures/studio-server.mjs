import { spawn } from "node:child_process";
// pnpm dev owns the production durable worker sidecar and its shutdown lifecycle.
const server = spawn("pnpm", ["dev", "--port", "3031"], {
  stdio: "inherit",
  env: process.env,
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.kill(signal));
server.on("exit", (code, signal) => {
  console.error(`[studio e2e server] exit=${code} signal=${signal}`);
  process.exit(code ?? 1);
});
