import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasCommand, resolveBin, run } from "../src/exec";
import { askClaude } from "../src/pick";
import { detectEncoder, renderClip, NO_LIBASS } from "../src/render";
import { effective } from "./settings";
import type { CheckResult } from "../lib/types";

/** Copy-pasteable fixes. Kept in one place so the CLI and the Settings page say the same thing. */
export const FIX = {
  tools: "brew install ffmpeg-full yt-dlp",
  libass: "brew install ffmpeg-full   # then relaunch; or point CAPY_FFMPEG_DIR at a build with libass",
  claude: "run `claude` in a terminal and log in",
} as const;

/** Names in the order they run. Exported so tests and the UI can pre-render the list. */
export const CHECKS = ["node", "yt-dlp", "ffmpeg", "captions", "encoder", "whisper", "claude"] as const;
export type CheckName = (typeof CHECKS)[number];

type Probe = () => Promise<{ detail: string; ok?: boolean; fix?: string }>;

function probes(model: string): Record<CheckName, Probe> {
  return {
    node: async () => ({ detail: process.version }),

    "yt-dlp": async () => {
      try {
        return { detail: (await run("yt-dlp", ["--version"])).stdout.trim() };
      } catch (e) {
        return { ok: false, detail: `not found (${firstLine(e)})`, fix: FIX.tools };
      }
    },

    ffmpeg: async () => {
      try {
        const v = (await run("ffmpeg", ["-version"])).stdout.split("\n")[0]!.replace("ffmpeg version ", "").split(" ")[0]!;
        const bin = resolveBin("ffmpeg");
        return { detail: bin === "ffmpeg" ? v : `${v} (${bin})` };
      } catch (e) {
        return { ok: false, detail: `not found (${firstLine(e)})`, fix: FIX.tools };
      }
    },

    captions: async () => {
      // real test render through the same code path as clips
      const dir = await mkdtemp(path.join(tmpdir(), "capy-check-"));
      try {
        const src = path.join(dir, "src.mp4");
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=1", "-f", "lavfi", "-i", "sine=d=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
        await renderClip(src, path.join(dir, "out.mp4"), [{ text: "test", start: 0.1, end: 0.6 }], { layout: "center", style: "bold", encoder: "auto", captions: true, hook: { text: "hook", seconds: 1 } });
        return { detail: "burned-in captions render ok" };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === NO_LIBASS) return { ok: false, detail: msg, fix: FIX.libass };
        return { ok: false, detail: msg.split("\n").filter(Boolean).slice(-2).join(" "), fix: FIX.tools };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    encoder: async () => {
      try {
        return { detail: await detectEncoder("auto") };
      } catch (e) {
        return { ok: false, detail: firstLine(e), fix: FIX.tools };
      }
    },

    // informational: only needed for videos without captions
    whisper: async () => ({
      detail: (await hasCommand("mlx_whisper")) ? "mlx_whisper (optional fallback)" : (await hasCommand("whisper-cli")) ? "whisper-cli (optional fallback)" : "none — only needed for videos without captions",
    }),

    claude: async () => {
      try {
        const r = await askClaude("Reply with the single word: ready", { model, tools: [], settingSources: [], persistSession: false, maxTurns: 1 }, { timeoutMs: 60_000 });
        return { detail: `${model} ok (${String(r.result).trim().slice(0, 20)})` };
      } catch (e) {
        return { ok: false, detail: firstLine(e), fix: FIX.claude };
      }
    },
  };
}

/**
 * Run every setup check in order, yielding one result at a time so callers can stream them
 * (the CLI prints as it goes; GET /api/check sends SSE). Never throws: a failure is a result
 * with `ok: false` and, where we know one, a `fix`.
 */
export async function* runChecks(o: { model?: string } = {}): AsyncGenerator<CheckResult> {
  const model = o.model ?? effective().model;
  const all = probes(model);
  for (const name of CHECKS) {
    let res: CheckResult;
    try {
      const r = await all[name]();
      res = { name, ok: r.ok ?? true, detail: r.detail, ...(r.fix && !(r.ok ?? true) ? { fix: r.fix } : {}) };
    } catch (e) {
      res = { name, ok: false, detail: firstLine(e), ...(name === "claude" ? { fix: FIX.claude } : name === "node" || name === "whisper" ? {} : { fix: FIX.tools }) };
    }
    yield res;
  }
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n").map((l) => l.trim()).find(Boolean) ?? "unknown error";
}
