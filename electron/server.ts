import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pickPort } from "./port";

export interface StartServerOptions {
  /** Spawn `next dev` from the project root instead of the packaged standalone server. */
  dev: boolean;
  /** Passed to the server as CAPY_DATA_DIR (settings.json lives there). */
  dataDir: string;
  /** Called if the server process exits (before or after readiness). */
  onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string[],
  ) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Last lines of stderr (ring buffer). */
  stderrTail: () => string[];
  /** SIGTERM, then SIGKILL after 3 s. Resolves once the process has exited. */
  stop: () => Promise<void>;
}

const STDERR_LINES = 30;
const POLL_MS = 250;
const READY_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_DEV_MS = 120_000;
const KILL_GRACE_MS = 3_000;

/** Dirs a Finder-launched app will not have on PATH but the pipeline needs (brew, yt-dlp, ffmpeg-full). */
export function toolPathDirs(home = os.homedir()): string[] {
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/opt/ffmpeg-full/bin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
    "/usr/bin",
    "/bin",
  ];
}

/** Existing PATH plus any of the tool dirs that are missing from it. */
export function augmentPath(
  current: string | undefined,
  home = os.homedir(),
): string {
  const parts = (current ?? "").split(path.delimiter).filter(Boolean);
  const have = new Set(parts);
  for (const dir of toolPathDirs(home)) if (!have.has(dir)) parts.push(dir);
  return parts.join(path.delimiter);
}

export class ServerError extends Error {
  constructor(
    message: string,
    public stderrTail: string[],
  ) {
    super(message);
  }
}

class RingBuffer {
  private lines: string[] = [];
  private partial = "";
  constructor(private size: number) {}
  push(chunk: string) {
    const text = this.partial + chunk;
    const parts = text.split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      this.lines.push(line);
      if (this.lines.length > this.size) this.lines.shift();
    }
  }
  tail(): string[] {
    return this.partial.trim()
      ? [...this.lines, this.partial].slice(-this.size)
      : [...this.lines];
  }
}

async function isReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/jobs`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startServer(
  opts: StartServerOptions,
): Promise<RunningServer> {
  const port = await pickPort();
  const url = `http://127.0.0.1:${port}`;
  const stderr = new RingBuffer(STDERR_LINES);

  // Record, not NodeJS.ProcessEnv: the project's env typings make NODE_ENV required, but dev must not set it.
  const baseEnv: Record<string, string | undefined> = {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    CAPY_DESKTOP: "1",
    CAPY_DATA_DIR: opts.dataDir,
    PATH: augmentPath(process.env.PATH),
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS ?? "",
      "--experimental-sqlite",
    ].join(" "),
  };

  let child: ChildProcess;
  if (opts.dev) {
    // Plain `next dev` from the project root; it is already a Node process, so no ELECTRON_RUN_AS_NODE.
    const {
      ELECTRON_RUN_AS_NODE: _runAsNode,
      NODE_ENV: _nodeEnv,
      ...env
    } = baseEnv;
    child = spawn("pnpm", ["exec", "next", "dev", "-p", String(port)], {
      cwd: process.cwd(),
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    // The packaged standalone server, run by the Electron binary in Node mode. ELECTRON_RUN_AS_NODE is
    // inherited by everything the server spawns, so the Claude Agent SDK's process.execPath launches
    // run as Node rather than opening another copy of the app.
    const serverJs = path.join(process.resourcesPath, "server", "server.js");
    child = spawn(process.execPath, [serverJs], {
      cwd: path.dirname(serverJs),
      env: {
        ...baseEnv,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  child.stdout?.on("data", (d: Buffer) =>
    process.stdout.write(`[server] ${d.toString()}`),
  );
  child.stderr?.on("data", (d: Buffer) => {
    const s = d.toString();
    stderr.push(s);
    process.stderr.write(`[server] ${s}`);
  });

  let exited = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      opts.onExit?.(code, signal, stderr.tail());
      resolve();
    });
  });
  child.once("error", (err) => {
    stderr.push(`spawn error: ${err.message}\n`);
  });

  const stop = async () => {
    if (exited || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const killer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    await exitPromise;
    clearTimeout(killer);
  };

  const timeoutMs = opts.dev ? READY_TIMEOUT_DEV_MS : READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      const info = exitInfo as {
        code: number | null;
        signal: NodeJS.Signals | null;
      } | null;
      throw new ServerError(
        `The capy server exited before it was ready (code ${info?.code ?? "?"}${info?.signal ? `, signal ${info.signal}` : ""}).`,
        stderr.tail(),
      );
    }
    if (await isReady(url)) {
      return { url, port, stderrTail: () => stderr.tail(), stop };
    }
    await sleep(POLL_MS);
  }
  await stop();
  throw new ServerError(
    `The capy server did not answer within ${Math.round(timeoutMs / 1000)} s.`,
    stderr.tail(),
  );
}
