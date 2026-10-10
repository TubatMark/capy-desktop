import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { augmentPath } from "./server";
export interface WorkerServiceOptions {
  dev: boolean;
  dataDir: string;
  onError?: (error: Error) => void;
  workerFile?: string;
  executable?: string;
  restartMs?: number;
}
export interface RunningWorker {
  stop(): Promise<void>;
  pid(): number | undefined;
}
/** Supervision is local to the app; SQLite elects one active worker across app/dev instances. */
export function startWorkerService(opts: WorkerServiceOptions): RunningWorker {
  let child: ChildProcess | undefined;
  let stopped = false;
  let restart: NodeJS.Timeout | undefined;
  let failures = 0;
  const launch = () => {
    if (stopped) return;
    const file =
      opts.workerFile ??
      (opts.dev
        ? path.resolve("dist-electron/worker.cjs")
        : path.join(process.resourcesPath, "server", "worker.cjs"));
    child = spawn(opts.executable ?? process.execPath, [file], {
      cwd: path.dirname(file),
      env: {
        ...process.env,
        CAPY_WORKER: "1",
        CAPY_DESKTOP: "1",
        CAPY_DATA_DIR: opts.dataDir,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS ?? "",
          "--experimental-sqlite",
        ].join(" "),
        PATH: augmentPath(process.env.PATH),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data) =>
      process.stdout.write(`[worker] ${data}`),
    );
    child.stderr?.on("data", (data) =>
      process.stderr.write(`[worker] ${data}`),
    );
    child.once("error", (error) => opts.onError?.(error));
    child.once("exit", () => {
      if (stopped) return;
      failures++;
      restart = setTimeout(
        launch,
        Math.min(30_000, (opts.restartMs ?? 500) * 2 ** Math.min(failures, 5)),
      );
    });
  };
  launch();
  return {
    pid: () => child?.pid,
    stop: async () => {
      stopped = true;
      if (restart) clearTimeout(restart);
      const target = child;
      if (!target || target.exitCode !== null || target.signalCode !== null)
        return;
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => target.kill("SIGKILL"), 3000);
        target.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        target.kill("SIGTERM");
      });
    },
  };
}
