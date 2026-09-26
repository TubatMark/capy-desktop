import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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
  return new Promise((resolve, reject) => {
    const p = spawn(resolveBin(cmd), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-MAX_KEEP);
      opts.onStderr?.(s);
    });
    p.on("error", (e) => reject(new Error(`Could not start "${cmd}": ${e.message}. Is it installed and on your PATH?`)));
    p.on("close", (code) => {
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
