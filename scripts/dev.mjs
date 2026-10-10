import { spawn } from "node:child_process";
// Dev and production browser commands own a worker process just as Electron does.
const mode = process.argv[2] ?? "dev";
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS ?? "", "--experimental-sqlite"].join(
    " ",
  ),
};
let worker;
let restart;
let stopping = false;
const launchWorker = () => {
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "server/worker/main.ts"],
    { env: { ...env, CAPY_WORKER: "1" }, stdio: "inherit" },
  );
  worker.once("exit", () => {
    if (!stopping) restart = setTimeout(launchWorker, 1000);
  });
};
launchWorker();
const server = spawn("pnpm", ["exec", "next", mode, ...process.argv.slice(3)], {
  env,
  stdio: "inherit",
});
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (restart) clearTimeout(restart);
  worker?.kill("SIGTERM");
  server.kill("SIGTERM");
};
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, stop);
server.once("exit", (code) => {
  stop();
  process.exitCode = code ?? 1;
});
