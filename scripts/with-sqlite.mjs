import { spawn } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
if (!command) throw Error("Missing command");
const existing = process.env.NODE_OPTIONS ?? "";
const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: existing.includes("--experimental-sqlite")
      ? existing
      : `${existing} --experimental-sqlite`.trim(),
  },
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
