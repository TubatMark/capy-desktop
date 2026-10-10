import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Finder-launched apps get a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew and
 * pip-installed tools (yt-dlp, ffmpeg, mlx_whisper) would be invisible. Prepend the usual
 * places if they are missing. Idempotent; returns the resulting PATH.
 */
export function ensureToolPaths(): string {
  const home = homedir();
  const want = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
  ];
  const py = path.join(home, "Library", "Python");
  let versions: string[] = [];
  try {
    versions = readdirSync(py);
  } catch {
    /* no user Python installs */
  }
  for (const v of versions.sort()) {
    const bin = path.join(py, v, "bin");
    if (existsSync(bin)) want.push(bin);
  }
  const current = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const missing = want.filter((d) => !current.includes(d));
  if (missing.length)
    process.env.PATH = [...missing, ...current].join(path.delimiter);
  return process.env.PATH ?? "";
}
ensureToolPaths();

/**
 * Cancel scope. `withCancel(signal, fn)` runs `fn` so that every process spawned inside it
 * (however deep the call stack) is tied to `signal` and killed when it aborts. Keeps the
 * pipeline functions free of a threaded-through signal parameter.
 */
const scope = new AsyncLocalStorage<AbortSignal>();
export interface ExecutionScope {
  assert?: () => void;
  timeoutMs?: number;
  onSpawn?: (pid: number, token: string) => void;
  onClose?: (pid: number) => void;
}
const execution = new AsyncLocalStorage<ExecutionScope>();
export const withExecution = <T>(
  value: ExecutionScope,
  fn: () => Promise<T>,
): Promise<T> => execution.run(value, fn);
export function registerSpawnedProcess(pid: number, token: string) {
  const ctx = execution.getStore();
  ctx?.assert?.();
  ctx?.onSpawn?.(pid, token);
}
export function assertExecutionCurrent() {
  execution.getStore()?.assert?.();
}
export function currentExecutionTimeout() {
  return execution.getStore()?.timeoutMs;
}
export function closeSpawnedProcess(pid: number) {
  execution.getStore()?.onClose?.(pid);
}
export class DeadlineError extends Error {
  constructor() {
    super("Subprocess deadline exceeded");
    this.name = "DeadlineError";
  }
}
/** A detached subprocess is the leader of its process group; stop its descendants as well. */
export function processIdentity(pid: number): string {
  try {
    return execFileSync(
      "ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "uid="],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}
function groupMembers(pid: number): number[] {
  try {
    return execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((row) => row.trim().split(/\s+/).map(Number))
      .filter((row) => row[1] === pid)
      .map((row) => row[0]!);
  } catch {
    return [];
  }
}
function hasProcessToken(pid: number, token: string): boolean {
  try {
    return execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).includes(`CAPY_PROCESS_TOKEN=${token}`);
  } catch {
    return false;
  }
}
export async function terminateProcessGroup(
  pid: number,
  graceMs = 150,
  token?: string,
  identity?: string,
): Promise<void> {
  // System binaries on macOS hide their environment; bind them to start time and user as well.
  const members = groupMembers(pid);
  const owned = members.some(
    (member) =>
      (token && hasProcessToken(member, token)) ||
      (member === pid && identity && processIdentity(member) === identity),
  );
  if (!owned) return;
  const original = new Map(
    members.map((member) => [member, processIdentity(member)]),
  );
  const kill = (signal: NodeJS.Signals) => {
    const live = groupMembers(pid);
    if (
      !live.some(
        (member) =>
          (token && hasProcessToken(member, token)) ||
          (original.get(member) &&
            original.get(member) === processIdentity(member)),
      )
    )
      return;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  kill("SIGKILL");
}

export function withCancel<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  return scope.run(signal, fn);
}

/** The cancel signal of the enclosing `withCancel` scope, if any. */
export function currentSignal(): AbortSignal | undefined {
  return scope.getStore();
}

/** Thrown (in place of the usual exec error) when the enclosing scope was cancelled. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

export function isCancelled(e: unknown): boolean {
  return (
    e instanceof CancelledError ||
    (e instanceof Error && e.name === "AbortError")
  );
}

/** Throw if the enclosing scope has been cancelled: call between steps that don't spawn anything. */
export function throwIfCancelled() {
  if (scope.getStore()?.aborted) throw new CancelledError();
}

/** Homebrew's slim `ffmpeg` has no libass; `ffmpeg-full` does but is keg-only (not on PATH). */
const FFMPEG_DIRS = [
  "/opt/homebrew/opt/ffmpeg-full/bin",
  "/usr/local/opt/ffmpeg-full/bin",
];

/** Resolve ffmpeg/ffprobe: $CAPY_FFMPEG_DIR, then Homebrew ffmpeg-full, then PATH. */
export function resolveBin(cmd: string): string {
  if (cmd !== "ffmpeg" && cmd !== "ffprobe") return cmd;
  for (const dir of [
    process.env.CAPY_FFMPEG_DIR ?? process.env.CLIPRUN_FFMPEG_DIR,
    ...FFMPEG_DIRS,
  ]) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return cmd;
}

export class ExecError extends Error {
  constructor(
    public cmd: string,
    public code: number | null,
    public stderr: string,
  ) {
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    super(`${cmd} exited with code ${code}\n${tail}`);
  }
}

export interface RunOpts {
  cwd?: string;
  /** Called with each stderr chunk (for progress output). */
  onStderr?: (chunk: string) => void;
  timeoutMs?: number;
  killGraceMs?: number;
}

const MAX_KEEP = 64 * 1024;

export function run(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  const signal = currentSignal();
  const context = execution.getStore();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    try {
      context?.assert?.();
    } catch (e) {
      return reject(e);
    }
    const token = randomUUID();
    const p = spawn(resolveBin(cmd), args, {
      cwd: opts.cwd,
      env: { ...process.env, CAPY_PROCESS_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const identity = p.pid ? processIdentity(p.pid) : "";
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let stopError: Error | undefined;
    let killing: Promise<void> | undefined;
    const stop = (error: Error) => {
      stopError ??= error;
      if (p.pid && !killing)
        killing = terminateProcessGroup(
          p.pid,
          opts.killGraceMs ?? 150,
          token,
          identity,
        );
    };
    const abort = () => stop(new CancelledError());
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => stop(new DeadlineError()),
      opts.timeoutMs ?? context?.timeoutMs ?? 30 * 60_000,
    );
    timeout.unref();
    try {
      if (p.pid) context?.onSpawn?.(p.pid, token);
    } catch (e) {
      stop(e as Error);
    }
    p.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes <= 16 * 1024 * 1024) out.push(d);
      else stop(new Error("Subprocess output limit exceeded"));
    });
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-MAX_KEEP);
      opts.onStderr?.(s);
    });
    p.on("error", (e) => {
      stopError ??= new Error(
        `Could not start "${cmd}": ${e.message}. Is it installed and on your PATH?`,
      );
    });
    p.on("close", async (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      // Await group termination even if the parent exits before a TERM-resistant descendant.
      if (killing) await killing;
      if (p.pid) context?.onClose?.(p.pid);
      if (stopError) return reject(stopError);
      try {
        context?.assert?.();
      } catch (e) {
        return reject(e);
      }
      if (code === 0)
        resolve({ stdout: Buffer.concat(out).toString(), stderr: err });
      else reject(new ExecError(cmd, code, err));
    });
  });
}

export async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await run("sh", ["-c", `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}
