import { spawn } from "node:child_process";
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
  const want = ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin")];
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
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const missing = want.filter((d) => !current.includes(d));
  if (missing.length) process.env.PATH = [...missing, ...current].join(path.delimiter);
  return process.env.PATH ?? "";
}
ensureToolPaths();


/**
 * Cancel scope. `withCancel(signal, fn)` runs `fn` so that every process spawned inside it
 * (however deep the call stack) is tied to `signal` and killed when it aborts. Keeps the
 * pipeline functions free of a threaded-through signal parameter.
 */
const scope = new AsyncLocalStorage<AbortSignal>();

export function withCancel<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
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
  return e instanceof CancelledError || (e instanceof Error && e.name === "AbortError");
}

/** Throw if the enclosing scope has been cancelled: call between steps that don't spawn anything. */
export function throwIfCancelled() {
  if (scope.getStore()?.aborted) throw new CancelledError();
}

/** Homebrew's slim `ffmpeg` has no libass; `ffmpeg-full` does but is keg-only (not on PATH). */
const FFMPEG_DIRS = ["/opt/homebrew/opt/ffmpeg-full/bin", "/usr/local/opt/ffmpeg-full/bin"];

/** Resolve ffmpeg/ffprobe: $CAPY_FFMPEG_DIR, then Homebrew ffmpeg-full, then PATH. */
export function resolveBin(cmd: string): string {
  if (cmd !== "ffmpeg" && cmd !== "ffprobe") return cmd;
  for (const dir of [(process.env.CAPY_FFMPEG_DIR ?? process.env.CLIPRUN_FFMPEG_DIR), ...FFMPEG_DIRS]) {
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
}

const MAX_KEEP = 64 * 1024;

export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<{ stdout: string; stderr: string }> {
  const signal = currentSignal();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    // `signal` makes node SIGTERM the child when the scope is cancelled
    const p = spawn(resolveBin(cmd), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-MAX_KEEP);
      opts.onStderr?.(s);
    });
    p.on("error", (e) => {
      if (isCancelled(e)) return reject(new CancelledError());
      reject(new Error(`Could not start "${cmd}": ${e.message}. Is it installed and on your PATH?`));
    });
    p.on("close", (code) => {
      if (signal?.aborted) return reject(new CancelledError());
      const stdout = Buffer.concat(out).toString();
      if (code === 0) resolve({ stdout, stderr: err });
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
