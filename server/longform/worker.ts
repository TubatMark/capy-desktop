import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { badgeFor, type LongClip, type LongVideo, type LongWorkStep } from "../../lib/longform";
import { detectEncoder } from "../../src/render";
import { run } from "../../src/exec";
import { assembleArgs, candidateArgs, cardArgs, cardAss, chapterLines, clipArgs, clipAss, concatList, keepRanges, rangesLength, readProblems, thumbArgs, thumbAss, wordsInCut, type Range } from "../../src/longform/edit";
import { speak } from "../../src/longform/narrate";
import { sectionCues } from "../../src/sfx";
import { pickCovers, reviewScript, reviseScript, screenClips, writeScript, type LongScript } from "../../src/longform/script";
import { getAccessToken, loadAccounts } from "../accounts";
import { loadSnapshot } from "../channel";
import { OUTPUT_ROOT } from "../paths";
import { dataDir, effective } from "../settings";
import { availableClips, clipWindow, fillClips, getVideo, listVideos, skipClips, loadAudience, patchVideo, saveAudience, videoDir, wordsFor } from "./store";
import { readAudience, readVideo, sendSlice, setThumbnail, startUpload, videoQuality, videoViews, type YtDeps } from "./youtube";

/** One step of work. Each returns the next, so sections and upload slices run as separate turns and posting can run between them. */
export interface Step {
  id: string;
  step: LongWorkStep;
  index?: number;
}

const ai = () => {
  const app = effective();
  return { agent: app.agent, model: app.agent === "claude" ? app.model : app.models[app.agent] };
};
const key = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const rel = (abs: string) => path.relative(OUTPUT_ROOT, abs);
const footage = (c: LongClip) => path.join(OUTPUT_ROOT, c.file);

// ---------- the sections of a video, in order ----------

export type Section =
  | { name: string; kind: "teaser"; clip: LongClip }
  | { name: string; kind: "card"; speech: string; title: string; clip: LongClip; badge?: string; line?: string; credit?: string }
  | { name: string; kind: "clip"; clip: LongClip; badge: string };

const pad = (i: number) => String(i).padStart(2, "0");
export function sections(v: LongVideo): Section[] {
  const n = v.clips.length;
  const best = v.clips[n - 1]!;
  const out: Section[] = [];
  // three short looks at the top moments, without their payoffs
  [n - 1, n - 2, n - 3].filter((i) => i >= 0).forEach((i, k) => out.push({ name: `teaser-${k}`, kind: "teaser", clip: v.clips[i]! }));
  out.push({ name: "intro", kind: "card", speech: v.intro ?? "", title: v.title, clip: best, line: "A ranking, with commentary" });
  v.clips.forEach((clip, i) => {
    const rank = n - i;
    const badge = badgeFor(v.format, rank, n, clip.label);
    out.push({ name: `rank-${pad(rank)}-card`, kind: "card", speech: clip.line ?? "", title: clip.title, clip, badge, line: clip.line, credit: `Source: ${clip.channel}` });
    out.push({ name: `rank-${pad(rank)}-clip`, kind: "clip", clip, badge });
  });
  out.push({ name: "outro", kind: "card", speech: v.outro ?? "", title: "What's your number one?", clip: v.clips[0]!, line: "Original streams are linked in the description" });
  return out;
}

const teaserRange = (c: LongClip): Range => {
  const w = clipWindow(c);
  const start = Math.max(w.start, w.start + (w.end - w.start) * 0.25);
  return { start, end: Math.min(w.end, start + 3.5) };
};
const toFootage = (ranges: Range[], c: LongClip): Range[] => ranges.map((r) => ({ start: Math.max(0, r.start - c.segStart), end: r.end - c.segStart }));

// ---------- steps ----------

export function descriptionFor(v: LongVideo, intro: string): string {
  const seen = new Set<string>();
  const credits = [...v.clips].reverse().flatMap((c, i) => {
    const at = `${c.sourceUrl}${c.sourceUrl.includes("?") ? "&" : "?"}t=${Math.floor(c.start)}s`;
    const line = `#${i + 1} ${c.title}: ${c.channel}, "${c.sourceTitle}" ${at}`;
    return seen.has(line) ? [] : (seen.add(line), [line]);
  });
  return `${intro}\n\nEvery moment comes from the original stream. Watch them there and support the creators:\n${credits.join("\n")}\n\nThe commentary is narrated with a text-to-speech voice.`;
}

const clipKey = (c: LongClip) => `${c.jobId}:${c.n}`;

/** Screen the picks, and refill with the next best (screened too) so a dropped moment doesn't shorten the video. */
async function screenPicks(v: LongVideo, screenedOut: NonNullable<LongVideo["screenedOut"]>): Promise<LongClip[]> {
  const check = async (list: LongClip[]) => {
    if (!list.length) return list;
    const drop = await screenClips(list.map((c) => ({ ...c, excerpt: wordsFor(c).map((w) => w.text).join(" ").slice(0, 450) })), ai());
    skipClips(drop.map((d) => clipKey(list[d.index]!)));
    screenedOut.push(...drop.map((d) => ({ title: list[d.index]!.title, why: d.why })));
    return list.filter((_, i) => !drop.some((d) => d.index === i));
  };
  let kept = await check(v.clips);
  const views = await viewsLookup();
  for (let round = 0; round < 3 && kept.length < v.clips.length; round++) {
    const mine = new Set(v.clips.map(clipKey));
    const spare = availableClips(views).filter((c) => !mine.has(clipKey(c)));
    const next = fillClips(kept, spare, v.creator).filter((c) => !kept.some((k) => clipKey(k) === clipKey(c)));
    if (!next.length) break;
    kept = fillClips([...kept, ...(await check(next))], [], v.creator);
    next.forEach((c) => mine.add(clipKey(c)));
  }
  return fillClips(kept, [], v.creator);
}

async function plan(v: LongVideo): Promise<Step> {
  patchVideo(v.id, { status: "planning", step: "Writing the commentary", error: undefined, failedStep: undefined });
  const excerpt = (c: LongClip) => ({ ...c, excerpt: wordsFor(c).map((w) => w.text).join(" ").slice(0, 450) });
  const screenedOut: NonNullable<LongVideo["screenedOut"]> = [];
  const screened = await screenPicks(v, screenedOut);
  const withWords = screened.map(excerpt);
  let script: LongScript = await writeScript(v.creator, withWords, ai(), v.format);
  const reviewFailed = { verdict: "caution" as const, notes: ["The automatic script review couldn't run"] };
  let review = await reviewScript(script, ai()).catch(() => reviewFailed);
  let fixTried = v.fixTried;
  if (review.verdict === "caution" && review !== reviewFailed) {
    fixTried = true;
    patchVideo(v.id, { step: "Fixing the review's notes" });
    script = await reviseScript(v.creator, withWords, script, review.notes, ai(), v.format);
    review = await reviewScript(script, ai()).catch(() => reviewFailed);
  }
  const clips = screened.map((c, i) => {
    const spoken = script.lines.find((l) => l.rank === screened.length - i)!;
    return { ...c, line: spoken.line.trim(), label: spoken.label.trim() };
  });
  const next: Partial<LongVideo> = {
    title: script.title.trim(),
    thumbnailText: script.thumbnailText.trim(),
    intro: script.intro.trim(),
    outro: script.outro.trim(),
    tags: script.tags,
    titleOptions: script.otherTitles.map((t) => t.trim()).filter(Boolean).slice(0, 2),
    clips,
    screenedOut,
    fixTried,
    check: { ok: review.verdict === "ok", duration: 0, warnings: [], script: review },
  };
  next.description = descriptionFor({ ...v, ...next }, script.description.trim());
  patchVideo(v.id, next);
  return { id: v.id, step: "narrate" };
}

const narrationBase = (id: string, text: string) => path.join(videoDir(id), "narration", key(text));
const spokenFile = (id: string, text: string) => [".wav", ".aiff"].map((x) => narrationBase(id, text) + x).find((f) => existsSync(f));

async function narrate(v: LongVideo): Promise<Step> {
  patchVideo(v.id, { status: "narrating", step: "Recording the narrator", error: undefined, failedStep: undefined });
  mkdirSync(path.join(videoDir(v.id), "narration"), { recursive: true });
  let voice = v.voice;
  for (const s of sections(v)) {
    if (s.kind !== "card" || spokenFile(v.id, s.speech)) continue;
    voice = (await speak(s.speech, narrationBase(v.id, s.speech), dataDir())).voice;
  }
  patchVideo(v.id, { voice });
  return { id: v.id, step: "render", index: 0 };
}

const LEAD = 0.35;
const TAIL = 0.5;
const seconds = async (file: string) => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
};

async function renderSection(v: LongVideo, s: Section, out: string, next?: Section) {
  const effects = effective().soundEffects;
  const dir = path.dirname(out);
  const assName = `${s.name}.ass`;
  const enc = await detectEncoder("auto");
  const temp = `${out}.part.mp4`;
  if (s.kind === "card") {
    const speech = spokenFile(v.id, s.speech);
    if (!speech) throw new Error(`The narration for ${s.name} is missing`);
    const total = (await seconds(speech)) + LEAD + TAIL;
    writeFileSync(path.join(dir, assName), cardAss({ badge: s.badge, format: v.format, title: s.title, line: s.line, seconds: total, credit: s.credit }));
    const w = clipWindow(s.clip);
    await run("ffmpeg", cardArgs({ footage: footage(s.clip), offset: w.start - s.clip.segStart, narration: speech, seconds: total, lead: LEAD, ass: assName, out: temp, enc, cues: effects ? sectionCues({ kind: "card", name: s.name, seconds: total }) : [] }), { cwd: dir });
  } else {
    const words = wordsFor(s.clip);
    const w = clipWindow(s.clip);
    const cut = s.kind === "teaser" ? [teaserRange(s.clip)] : keepRanges(words, w.start, w.end);
    const total = rangesLength(cut);
    const on = wordsInCut(words, cut);
    const ass = s.kind === "teaser"
      ? clipAss({ title: "Coming up", credit: `Source: ${s.clip.channel}`, seconds: total, words: on })
      : clipAss({ badge: s.badge, title: s.clip.title, credit: `Source: ${s.clip.channel}`, seconds: total, words: on });
    writeFileSync(path.join(dir, assName), ass);
    await run("ffmpeg", clipArgs({ footage: footage(s.clip), ranges: toFootage(cut, s.clip), ass: assName, out: temp, enc, cues: effects ? sectionCues({ kind: s.kind, name: s.name, seconds: total, lastTeaser: next?.kind !== "teaser" }) : [] }), { cwd: dir });
  }
  await run("mv", [temp, out]);
}

async function render(v: LongVideo, index: number): Promise<Step> {
  const all = sections(v);
  const s = all[index]!;
  const dir = path.join(videoDir(v.id), "sections");
  mkdirSync(dir, { recursive: true });
  patchVideo(v.id, { status: "rendering", step: `Editing ${index + 1} of ${all.length}`, progress: index / all.length, error: undefined, failedStep: undefined });
  const out = path.join(dir, `${pad(index)}-${s.name}.mp4`);
  if (!existsSync(out)) await renderSection(v, s, out, all[index + 1]);
  return index + 1 < all.length ? { id: v.id, step: "render", index: index + 1 } : { id: v.id, step: "assemble" };
}

/** Stills from the top moments; the AI picks up to three. If it can't, the top moment's middle, which shows at review. */
async function chooseCovers(v: LongVideo, dir: string): Promise<{ clip: LongClip; offset: number; headline: string }[]> {
  const options = v.clips.slice(-5).reverse().flatMap((clip) => [0.3, 0.65].map((p) => ({ clip, offset: Math.max(0, clip.start - clip.segStart + (clip.end - clip.start) * p) })));
  const files: string[] = [];
  mkdirSync(path.join(dir, "covers"), { recursive: true });
  for (const [i, o] of options.entries()) {
    const f = path.join(dir, "covers", `${i}.jpg`);
    await run("ffmpeg", candidateArgs(footage(o.clip), o.offset, f));
    files.push(f);
  }
  const picks = await pickCovers(files, v.title).catch((e) => {
    console.error("[long-form] cover", e);
    return [];
  });
  if (!picks.length) return [{ ...options[1]!, headline: v.thumbnailText ?? v.title }];
  return picks.map((p) => ({ ...options[p.index]!, headline: p.headline }));
}

async function assemble(v: LongVideo): Promise<Step> {
  patchVideo(v.id, { status: "rendering", step: "Joining the sections", progress: 1, error: undefined, failedStep: undefined });
  const dir = videoDir(v.id);
  const files = sections(v).map((s, i) => path.join(dir, "sections", `${pad(i)}-${s.name}.mp4`));
  const list = path.join(dir, "sections.txt");
  writeFileSync(list, concatList(files));
  const master = path.join(dir, "master.mp4");
  await run("ffmpeg", assembleArgs(list, master));
  const covers = await chooseCovers(v, dir);
  const thumbs: string[] = [];
  for (const [i, cover] of covers.entries()) {
    const file = path.join(dir, i === 0 ? "thumb.jpg" : `thumb-${i + 1}.jpg`);
    const ass = `thumb-${i + 1}.ass`;
    writeFileSync(path.join(dir, ass), thumbAss(cover.headline));
    await run("ffmpeg", thumbArgs({ footage: footage(cover.clip), offset: cover.offset, ass, out: file }), { cwd: dir });
    thumbs.push(file);
  }
  const thumb = thumbs[0]!;
  const cover = covers[0]!;
  const parts = await Promise.all(
    sections(v).map(async (s, i) => ({
      title: s.name === "teaser-0" ? "Intro" : s.kind === "card" && s.badge !== undefined ? `${s.badge}: ${s.title}` : s.name === "outro" ? "Your number one" : "",
      seconds: await seconds(files[i]!),
    })),
  );
  const chapters = chapterLines(parts);
  patchVideo(v.id, {
    master: rel(master),
    thumb: rel(thumb),
    thumbOptions: thumbs.slice(1).map(rel),
    masterBytes: statSync(master).size,
    thumbnailText: cover.headline,
    description: chapters.length ? `${v.description ?? ""}\n\nChapters:\n${chapters.join("\n")}` : v.description,
  });
  return { id: v.id, step: "check" };
}

/** Looks for what a viewer would notice, from a small copy so it doesn't take long. */
async function check(v: LongVideo): Promise<null> {
  patchVideo(v.id, { status: "checking", step: "Checking the finished video", error: undefined, failedStep: undefined });
  const master = path.join(OUTPUT_ROOT, v.master!);
  const duration = await seconds(master);
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", master, "-vf", "fps=5,scale=320:-2,blackdetect=d=3:pix_th=0.08", "-af", "silencedetect=n=-45dB:d=6", "-f", "null", "-"]);
  const { stdout: streams } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", master]);
  const cards: Range[] = [];
  let at = 0;
  for (const [i, s] of sections(v).entries()) {
    const length = await seconds(path.join(videoDir(v.id), "sections", `${pad(i)}-${s.name}.mp4`));
    if (s.kind === "card") cards.push({ start: at, end: at + length });
    at += length;
  }
  const warnings = readProblems(stderr, cards);
  if (!/audio/.test(streams)) warnings.unshift("The video has no sound");
  if (!/video,1920,1080/.test(streams)) warnings.unshift("The video isn't 1920x1080");
  const script = v.check?.script;
  patchVideo(v.id, { status: "review", step: undefined, progress: undefined, check: { ok: warnings.length === 0 && script?.verdict !== "caution", duration, warnings, script } });
  return null;
}

// ---------- YouTube ----------

export async function ytDeps(): Promise<YtDeps> {
  const account = loadAccounts().youtube.account?.id;
  return { fetch, token: await getAccessToken("youtube", fetch, account) };
}

async function upload(v: LongVideo): Promise<Step | null> {
  const file = path.join(OUTPUT_ROOT, v.master!);
  const size = statSync(file).size;
  const d = await ytDeps();
  let session = v.youtube?.session;
  if (!v.youtube?.id) {
    if (!session) {
      session = await startUpload(d, v, size);
      patchVideo(v.id, { status: "uploading", youtube: { ...v.youtube, session, offset: 0, size } });
    }
    const sent = await sendSlice(d, session, file, size);
    patchVideo(v.id, { status: "uploading", step: `Uploaded ${Math.round((sent.offset / size) * 100)}%`, progress: sent.offset / size, error: undefined, failedStep: undefined, youtube: { ...getVideo(v.id)!.youtube, session, offset: sent.offset, size, id: sent.id } });
    if (!sent.id) return { id: v.id, step: "upload" };
  }
  const cur = getVideo(v.id)!;
  let thumbnail = cur.youtube?.thumbnail;
  let note = cur.youtube?.note;
  if (cur.thumb && thumbnail !== "set") {
    try {
      await setThumbnail(d, cur.youtube!.id!, path.join(OUTPUT_ROOT, cur.thumb));
      thumbnail = "set";
    } catch (e) {
      // custom thumbnails need a verified channel: worth telling the owner, not worth failing the upload
      thumbnail = "failed";
      note = (e as Error).message;
    }
  }
  patchVideo(v.id, { status: "processing", step: "YouTube is processing it", progress: undefined, youtube: { ...cur.youtube, session: undefined, thumbnail, note } });
  return null;
}

/** Follow every uploaded video: processing done, gone public, views after 48 hours and a week. */
export async function observe(now = Date.now()): Promise<null> {
  // once a video has its week-old numbers there's nothing left to watch for
  const active = listVideos().filter((v) => v.youtube?.id && !v.youtube.rejected && !v.metrics?.some((m) => m.ageHours === 168));
  const audienceOld = (loadAudience()?.fetchedAt ?? 0) < now - 7 * 86400_000;
  if (!active.length && !audienceOld) return null;
  if (!loadAccounts().youtube.tokens?.accessToken) return null;
  const d = await ytDeps();
  if (audienceOld) await readAudience(d, now).then(saveAudience).catch((e) => console.error("[long-form] audience", e));
  for (const v of active) {
    const id = v.youtube!.id!;
    const remote = await readVideo(d, id);
    if (!remote) continue;
    const youtube = { ...v.youtube! };
    const patch: Partial<LongVideo> = {};
    if (remote.uploadStatus === "rejected" || remote.uploadStatus === "failed") {
      youtube.rejected = remote.rejectionReason ?? remote.failureReason ?? remote.uploadStatus;
      patch.error = `YouTube ${remote.uploadStatus} it: ${youtube.rejected}`;
    } else if (remote.uploadStatus === "processed" || remote.privacy === "public") youtube.processedAt ??= now;
    if (remote.privacy === "public") youtube.publishedAt ??= remote.publishAt && remote.publishAt <= now ? remote.publishAt : now;
    if (v.status !== "freed" && youtube.processedAt) {
      if (remote.privacy === "public") patch.status = "public";
      else if (remote.publishAt) patch.status = "scheduled";
      else patch.status = "private";
      patch.step = undefined;
      if (!remote.publishAt && v.status === "scheduled") {
        patch.slotAt = undefined;
        patch.slotId = undefined;
      }
    }
    if (youtube.publishedAt) {
      const metrics = [...(v.metrics ?? [])];
      for (const ageHours of [48, 168] as const) {
        if (now - youtube.publishedAt < ageHours * 3600_000 || metrics.some((m) => m.ageHours === ageHours)) continue;
        const seen = await videoViews(d, id, youtube.publishedAt, now).catch(() => null);
        if (seen) metrics.push({ at: now, ageHours, ...seen, ...(await videoQuality(d, id, youtube.publishedAt, now).catch(() => ({}))) });
      }
      patch.metrics = metrics;
    }
    patchVideo(v.id, { ...patch, youtube });
  }
  return null;
}

export async function viewsLookup(): Promise<(id: string) => number | undefined> {
  const snapshot = await loadSnapshot().catch(() => null);
  const views = new Map((snapshot?.videos ?? []).map((v) => [v.id, v.views]));
  return (id) => views.get(id);
}

/** Do one step; the caller queues whatever comes back. */
export async function runStep(s: Step): Promise<Step | null> {
  if (s.step === "observe") return observe();
  const v = getVideo(s.id);
  if (!v) return null;
  switch (s.step) {
    case "plan":
      return plan(v);
    case "narrate":
      return narrate(v);
    case "render":
      return render(v, s.index ?? 0);
    case "assemble":
      return assemble(v);
    case "check":
      return check(v);
    case "upload":
      return upload(v);
  }
}

export function markFailed(s: Step, e: unknown) {
  if (s.step === "observe" || !getVideo(s.id)) return;
  patchVideo(s.id, { error: e instanceof Error ? e.message : String(e), failedStep: s.step, failedIndex: s.index, step: undefined });
}
