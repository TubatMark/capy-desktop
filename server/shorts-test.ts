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
import { getAccessToken, loadAccounts } from "./accounts";
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
  const group = shortTestGroup(job.id, c.n);
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

const RESULTS = "shorts-test-results";
const REFRESH_MS = 6 * 3600_000;
let lastRefresh = 0;

interface RawJob {
  id: string;
  clips?: { n: number; shortTest?: { group: string } }[];
}

/** Feed views for every test Short that has posted, from YouTube Analytics. */
export async function refreshShortTest(now = Date.now(), f: typeof fetch = fetch) {
  if (now - lastRefresh < REFRESH_MS) return;
  lastRefresh = now;
  const store = runtimeStore();
  const groups = new Map<string, string>();
  for (const { value: job } of store.list<RawJob>("legacy-jobs"))
    for (const c of job.clips ?? []) if (c.shortTest && c.shortTest.group !== "failed") groups.set(`${job.id}:${c.n}`, c.shortTest.group);
  if (!groups.size) return;
  const posted = (store.get<{ jobId?: string; n?: number; status: string; result?: { id?: string }; updatedAt?: number }[]>("legacy-state", "queue")?.value ?? []).filter(
    (e) => e.status === "posted" && e.result?.id && groups.has(`${e.jobId}:${e.n}`),
  );
  if (!posted.length) return;
  const account = loadAccounts().youtube.account?.id;
  const token = await getAccessToken("youtube", f, account);
  const results: ShortTestResult[] = [];
  for (const e of posted) {
    const q = new URLSearchParams({
      ids: "channel==MINE",
      startDate: "2026-01-01",
      endDate: new Date(now).toISOString().slice(0, 10),
      metrics: "views",
      dimensions: "insightTrafficSourceType",
      filters: `video==${e.result!.id}`,
    });
    const r = await f(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) continue;
    const rows = ((await r.json()) as { rows?: [string, number][] }).rows ?? [];
    const totals = new URLSearchParams({ ids: "channel==MINE", startDate: "2026-01-01", endDate: new Date(now).toISOString().slice(0, 10), metrics: "views,engagedViews", filters: `video==${e.result!.id}` });
    const t = await f(`https://youtubeanalytics.googleapis.com/v2/reports?${totals}`, { headers: { Authorization: `Bearer ${token}` } });
    const total = t.ok ? ((await t.json()) as { rows?: number[][] }).rows?.[0] : undefined;
    results.push({
      videoId: e.result!.id!,
      group: groups.get(`${e.jobId}:${e.n}`) as ShortTestResult["group"],
      postedAt: e.updatedAt ?? now,
      views: rows.reduce((a, x) => a + Number(x[1]), 0),
      feedViews: Number(rows.find((x) => x[0] === "SHORTS")?.[1] ?? 0),
      stayed: total && total[0]! > 0 ? total[1]! / total[0]! : undefined,
    });
  }
  store.put(CONFIG, RESULTS, results);
}

export function shortTestReport(now = Date.now()) {
  const results = runtimeStore().get<ShortTestResult[]>(CONFIG, RESULTS)?.value ?? [];
  return { ...loadShortTest(), summary: shortTestSummary(results, now) };
}
