import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClipState, JobState } from "../lib/types";
import type { Word } from "../src/types";
import { shortTestSummary, type ShortTestResult, type ShortTestState } from "../lib/shorts-test";
import { run } from "../src/exec";
import { speak } from "../src/longform/narrate";
import { detectEncoder } from "../src/render";
import { commentaryArgs, commentaryAss, middleAt, outroLength, writeCommentary } from "../src/shorts-commentary";
import { runtimeStore } from "./db/runtime";
import { dataDir, effective } from "./settings";

const CONFIG = "longform-config";
const seconds = async (file: string) => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Couldn't read the length of ${path.basename(file)}`);
  return d;
};

export const loadShortTest = (): ShortTestState => runtimeStore().get<ShortTestState>(CONFIG, "shorts-test")?.value ?? { on: false };
export function setShortTest(on: boolean, now = Date.now()) {
  const cur = loadShortTest();
  runtimeStore().put(CONFIG, "shorts-test", { on, startedAt: cur.startedAt ?? (on ? now : undefined) });
}

/** Set by the daily check once there's evidence either way. */
const loadNarrateMode = () => runtimeStore().get<{ narrate?: "half" | "all" | "off" }>(CONFIG, "tuning")?.value.narrate ?? "half";

/** Half the clips, the same half every time a clip is rendered again. */
export const shortTestGroup = (jobId: string, n: number): "narrated" | "plain" =>
  createHash("sha256").update(`${jobId}:${n}`).digest()[0]! % 2 === 0 ? "narrated" : "plain";

/**
 * Runs right after a clip renders, so a narrated clip goes through the same quality checks and attribution as a plain
 * one. Only clips of automated jobs that started after the test did: nothing already made or scheduled changes. Any
 * failure leaves the plain render in place, because a Short matters more than the test. Returns the seconds it added.
 */
export async function applyShortTest(job: JobState, c: ClipState, file: string, words: Word[]): Promise<number> {
  const test = loadShortTest();
  if (!test.on || !test.startedAt || !job.automation || (job.createdAt ?? 0) < test.startedAt) return 0;
  const narrate = loadNarrateMode();
  const group = narrate === "all" ? "narrated" : narrate === "off" ? "plain" : shortTestGroup(job.id, c.n);
  if (group === "plain") {
    c.shortTest = { group };
    return 0;
  }
  const base = file.replace(/\.mp4$/, "");
  const temp = [`${base}.narrated.ass`, `${base}.opening.wav`, `${base}.opening.aiff`, `${base}.opening.txt`, `${base}.verdict.wav`, `${base}.verdict.aiff`, `${base}.verdict.txt`, `${base}.middle.wav`, `${base}.middle.aiff`, `${base}.middle.txt`, `${base}.narrated.part`];
  try {
    const app = effective();
    const excerpt = words.filter((w) => w.end > c.start && w.start < c.end).map((w) => w.text).join(" ").slice(0, 500);
    const lines = await writeCommentary(
      { creator: job.channel ?? "this creator", title: c.title, reason: c.reason, excerpt },
      { agent: app.agent, model: app.agent === "claude" ? app.model : app.models[app.agent] },
    );
    const opening = await speak(lines.opening, `${base}.opening`, dataDir());
    const verdict = await speak(lines.verdict, `${base}.verdict`, dataDir());
    const clipSeconds = await seconds(file);
    const at = middleAt(words.filter((w) => w.start >= c.start && w.end <= c.end).map((w) => ({ start: w.start - c.start, end: w.end - c.start })), clipSeconds);
    const spoken = at === undefined ? undefined : await speak(lines.middle, `${base}.middle`, dataDir());
    const middle = at !== undefined && spoken && at + spoken.seconds < clipSeconds - 1 ? { file: spoken.file, at, seconds: spoken.seconds } : undefined;
    writeFileSync(
      `${base}.narrated.ass`,
      commentaryAss({
        opening: lines.opening,
        openingEnd: Math.min(clipSeconds, opening.seconds + 0.4),
        middle: middle ? { text: lines.middle, start: middle.at, end: middle.at + middle.seconds + 0.2 } : undefined,
        verdict: lines.verdict,
        outroStart: clipSeconds,
        outroEnd: clipSeconds + outroLength(verdict.seconds),
      }),
    );
    const out = `${base}.narrated.part`;
    const { args, added } = commentaryArgs({
      clip: file,
      clipSeconds,
      opening: opening.file,
      openingSeconds: opening.seconds,
      middle,
      verdict: verdict.file,
      verdictSeconds: verdict.seconds,
      ass: path.basename(`${base}.narrated.ass`),
      out: `${out}.mp4`,
      enc: await detectEncoder("auto"),
    });
    await run("ffmpeg", args, { cwd: path.dirname(file) });
    renameSync(`${out}.mp4`, file);
    c.shortTest = { group, ...lines, voice: opening.voice };
    return added;
  } catch (e) {
    c.shortTest = { group: "failed", error: e instanceof Error ? e.message : String(e) };
    return 0;
  } finally {
    for (const f of [...temp, `${base}.narrated.part.mp4`]) rmSync(f, { force: true });
  }
}

// ---------- results ----------

export const SHORT_TEST_RESULTS = "shorts-test-results";
export function shortTestReport(now = Date.now()) {
  const results = runtimeStore().get<ShortTestResult[]>(CONFIG, SHORT_TEST_RESULTS)?.value ?? [];
  return { ...loadShortTest(), narrate: loadNarrateMode(), summary: shortTestSummary(results, now) };
}
