import { beforeEach, describe, expect, it, vi } from "vitest";

// No ffmpeg, yt-dlp, network or Claude login needed: every probe is mocked.
vi.mock("../src/exec", () => ({
  run: vi.fn(),
  hasCommand: vi.fn(async () => false),
  resolveBin: vi.fn((cmd: string) => cmd),
  ensureToolPaths: vi.fn(() => ""),
}));
vi.mock("../src/pick", () => ({ askClaude: vi.fn() }));
vi.mock("../src/render", () => ({
  renderClip: vi.fn(async () => {}),
  detectEncoder: vi.fn(async () => "h264_videotoolbox"),
  NO_LIBASS: "ffmpeg has no libass",
}));

import { run, hasCommand } from "../src/exec";
import { askClaude } from "../src/pick";
import { renderClip } from "../src/render";
import { CHECKS, FIX, runChecks } from "../server/doctor";
import type { CheckResult } from "../lib/types";

const mRun = vi.mocked(run);
const mAsk = vi.mocked(askClaude);
const mRender = vi.mocked(renderClip);
const mHas = vi.mocked(hasCommand);

async function collect(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for await (const r of runChecks({ model: "claude-test" })) out.push(r);
  return out;
}

function healthy() {
  mRun.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === "yt-dlp") return { stdout: "2026.09.01\n", stderr: "" };
    if (cmd === "ffmpeg" && args[0] === "-version") return { stdout: "ffmpeg version 8.0 Copyright ...\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  mRender.mockResolvedValue(undefined as never);
  mAsk.mockResolvedValue({ result: "ready" });
  mHas.mockResolvedValue(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  healthy();
});

describe("runChecks", () => {
  it("yields one result per named check, in order, all ok on a healthy machine", async () => {
    const rs = await collect();
    expect(rs.map((r) => r.name)).toEqual([...CHECKS]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.every((r) => typeof r.detail === "string" && r.detail.length > 0)).toBe(true);
    expect(rs.some((r) => r.fix)).toBe(false);
    expect(rs.find((r) => r.name === "node")!.detail).toBe(process.version);
    expect(rs.find((r) => r.name === "yt-dlp")!.detail).toBe("2026.09.01");
    expect(rs.find((r) => r.name === "ffmpeg")!.detail).toBe("8.0");
    expect(rs.find((r) => r.name === "claude")!.detail).toContain("claude-test ok (ready)");
    expect(mAsk).toHaveBeenCalledTimes(1);
  });

  it("reports missing yt-dlp / ffmpeg with the brew fix", async () => {
    mRun.mockImplementation(async (cmd: string) => {
      if (cmd === "yt-dlp" || cmd === "ffmpeg") throw new Error(`Could not start "${cmd}": spawn ${cmd} ENOENT. Is it installed and on your PATH?`);
      return { stdout: "", stderr: "" };
    });
    const rs = await collect();
    const yt = rs.find((r) => r.name === "yt-dlp")!;
    const ff = rs.find((r) => r.name === "ffmpeg")!;
    const cap = rs.find((r) => r.name === "captions")!;
    expect(yt.ok).toBe(false);
    expect(yt.fix).toBe(FIX.tools);
    expect(ff.ok).toBe(false);
    expect(ff.fix).toBe(FIX.tools);
    expect(cap.ok).toBe(false);
    expect(cap.fix).toBe(FIX.tools);
    // unrelated checks are unaffected
    expect(rs.find((r) => r.name === "claude")!.ok).toBe(true);
  });

  it("points at ffmpeg-full when libass is missing", async () => {
    mRender.mockRejectedValue(new Error("ffmpeg has no libass"));
    const cap = (await collect()).find((r) => r.name === "captions")!;
    expect(cap.ok).toBe(false);
    expect(cap.detail).toBe("ffmpeg has no libass");
    expect(cap.fix).toContain("brew install ffmpeg-full");
    expect(cap.fix).toContain("CAPY_FFMPEG_DIR");
  });

  it("tells you to log in when Claude fails", async () => {
    mAsk.mockRejectedValue(new Error("Claude login missing or expired. Run `claude`, log in, then try again.\nmore"));
    const c = (await collect()).find((r) => r.name === "claude")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toBe("Claude login missing or expired. Run `claude`, log in, then try again.");
    expect(c.fix).toBe(FIX.claude);
  });

  it("treats whisper as informational", async () => {
    const w = (await collect()).find((r) => r.name === "whisper")!;
    expect(w.ok).toBe(true);
    expect(w.detail).toContain("only needed for videos without captions");
    mHas.mockImplementation(async (cmd: string) => cmd === "mlx_whisper");
    expect((await collect()).find((r) => r.name === "whisper")!.detail).toContain("mlx_whisper");
  });
});
