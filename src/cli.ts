#!/usr/bin/env tsx
import { mkdir, mkdtemp, writeFile, readFile, access, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDotEnv } from "./env";
loadDotEnv();
import { fetchAudio, fetchCaptions, fetchMeta, fetchSection, videoIdFromUrl } from "./youtube";
import { wordsInRange } from "./captions";
import { askClaude, pickClips } from "./pick";
import { agentSpec } from "./agents";
import { renderClip, detectEncoder, probeVideo, NO_LIBASS } from "./render";
import { transcribe } from "./transcribe";
import { writePublishFiles } from "./pipeline";
import { hasCommand, resolveBin, run } from "./exec";
import { fmtTime, log, pad2, pool, slug } from "./util";
import type { Clip, RenderedClip, VideoMeta, Word } from "./types";

/** Good judgment at a fraction of Opus usage. Override with --model or CAPY_MODEL. */
const DEFAULT_MODEL = "claude-sonnet-5";

const HELP = `capy — YouTube URL -> captioned 9:16 shorts, picked by Claude

Usage:
  pnpm clip <youtube-url> [options]
  pnpm check

Options:
  -o, --out <dir>        Output root (default: ./output)
  -n, --count <n>        Clips to ask for (default: 6)
  --min <sec>            Min clip length (default: 20)
  --max <sec>            Max clip length (default: 60)
  --focus "<text>"       Guidance for the picker, e.g. "every joke that landed"
  --layout center|blur   Vertical framing (default: center)
  --style bold|clean     Caption style (default: bold)
  --no-captions          Skip burned-in captions
  --no-hook              Skip the hook text overlay
  --lang <code>          Caption language to prefer (default: the spoken language)
  --agent <id>           AI that picks: claude (default), codex, cursor, gemini,
                         opencode, droid, copilot, qwen, amp (or CAPY_AGENT)
  --model <id>           Model for picking (Claude default: ${DEFAULT_MODEL};
                         claude-haiku-4-5 is cheaper, claude-opus-5-5 is best)
  --browser <name>       Use cookies from your browser: chrome, safari, firefox, brave
                         (fixes 429 / "confirm you're not a bot")
  --cookies <file>       Or a cookies.txt export
  --proxy <url>          Proxy for yt-dlp (e.g. http://user:pass@host:port)
  --max-res <p>          Source resolution cap: 2160, 1440, 1080, 720 (default: 2160)
                         4K crops to a much sharper 9:16; lower = faster downloads
  --jobs <n>             Parallel downloads/renders (default: 2)
  --pick-only            Stop after picking; write clips.json and exit
  --repick               Ask Claude again even if clips.json exists
  --from-picks <file>    Use picks from another clips.json
  --whisper              Transcribe locally even if YouTube has captions
  -h, --help
`;

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o", default: "output" },
      count: { type: "string", short: "n", default: "6" },
      min: { type: "string", default: "20" },
      max: { type: "string", default: "60" },
      focus: { type: "string" },
      layout: { type: "string", default: "center" },
      style: { type: "string", default: "bold" },
      "no-captions": { type: "boolean", default: false },
      "no-hook": { type: "boolean", default: false },
      lang: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      proxy: { type: "string" },
      cookies: { type: "string" },
      browser: { type: "string" },
      jobs: { type: "string", default: "2" },
      "max-res": { type: "string", default: "2160" },
      "pick-only": { type: "boolean", default: false },
      repick: { type: "boolean", default: false },
      "from-picks": { type: "string" },
      whisper: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (positionals[0] === "doctor" || positionals[0] === "check") return doctor();
  const url = positionals[0];
  if (v.help || !url) {
    console.log(HELP);
    process.exit(v.help ? 0 : 1);
  }
  const id = videoIdFromUrl(url);
  if (!id) throw new Error(`Not a YouTube URL: ${url}`);

  const count = int("--count", v.count!, 1, 30);
  const minSec = int("--min", v.min!, 5, 600);
  const maxSec = int("--max", v.max!, minSec, 600);
  let jobs = int("--jobs", v.jobs!, 1, 8);
  const maxRes = int("--max-res", v["max-res"]!, 360, 4320);
  if (!["center", "blur"].includes(v.layout!)) throw new Error(`--layout must be center or blur (got "${v.layout}")`);
  if (!["bold", "clean"].includes(v.style!)) throw new Error(`--style must be bold or clean (got "${v.style}")`);
  const agent = agentSpec(v.agent ?? process.env.CAPY_AGENT ?? "claude").id;
  const model = v.model ?? (agent === "claude" ? ((process.env.CAPY_MODEL ?? process.env.CLIPRUN_MODEL) ?? DEFAULT_MODEL) : undefined);

  const yt = { proxy: v.proxy ?? process.env.YT_PROXY, cookies: v.cookies, cookiesFromBrowser: v.browser ?? (process.env.CAPY_BROWSER ?? process.env.CLIPRUN_BROWSER) };
  if (yt.cookies && jobs > 1) jobs = 1; // parallel yt-dlp runs would both rewrite the cookies file
  const captions = !v["no-captions"];
  const hook = !v["no-hook"];

  // 1. metadata (reused from an earlier run of the same video)
  const outRoot = path.resolve(v.out!);
  let meta: VideoMeta;
  let jobDir = await findJobDir(outRoot, id);
  if (jobDir) {
    meta = JSON.parse(await readFile(path.join(jobDir, "meta.json"), "utf8"));
    log("meta", `"${meta.title}" (cached)`);
  } else {
    log("meta", `fetching ${url}`);
    meta = await fetchMeta(url, yt);
    jobDir = path.join(outRoot, `${slug(meta.title, 48)}-${meta.id}`);
    log("meta", `"${meta.title}" — ${fmtTime(meta.duration)} — ${meta.channel ?? ""}`);
  }
  const workDir = path.join(jobDir, "work");
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  log("meta", `-> ${path.relative(process.cwd(), jobDir) || jobDir}`);

  // 2. transcript (cached unless --whisper/--lang ask for a different one)
  const wordsFile = path.join(jobDir, "words.json");
  let words: Word[];
  if ((await exists(wordsFile)) && !v.whisper && !v.lang) {
    words = JSON.parse(await readFile(wordsFile, "utf8"));
    log("captions", `${words.length} words (cached)`);
  } else {
    let got: Word[] | null = null;
    let captionErr: string | undefined;
    if (!v.whisper) {
      try {
        got = await fetchCaptions(url, workDir, v.lang, yt, meta);
        log("captions", got ? `${got.length} words from YouTube captions` : "this video has no captions");
      } catch (e) {
        captionErr = lastLines(e, 1);
        log("captions", `download failed: ${captionErr}`);
      }
    }
    if (!got) {
      try {
        log("whisper", "downloading audio for local transcription");
        const audio = await fetchAudio(url, path.join(workDir, "audio.m4a"), yt);
        log("whisper", "transcribing (the slow part)");
        got = await transcribe(audio, workDir, { language: v.lang });
        log("whisper", `${got.length} words`);
      } catch (e) {
        const hint = captionErr ? `YouTube captions failed (${captionErr}). Try --browser chrome, or wait a few minutes.\n` : "";
        throw new Error(hint + (e instanceof Error ? e.message : String(e)));
      }
    }
    words = got;
    await writeFile(wordsFile, JSON.stringify(words));
  }
  if (words.length < 30) throw new Error("Transcript is too short to clip from.");

  // 3. pick (reuses clips.json unless --repick)
  let clips: Clip[];
  const clipsFile = path.join(jobDir, "clips.json");
  const picksSource = v["from-picks"] ?? (!v.repick && (await exists(clipsFile)) ? clipsFile : undefined);
  if (picksSource) {
    clips = JSON.parse(await readFile(picksSource, "utf8")).clips;
    if (!Array.isArray(clips)) throw new Error(`${picksSource} has no "clips" array`);
    if (path.resolve(picksSource) !== clipsFile) await writeFile(clipsFile, JSON.stringify({ video: meta.url, clips }, null, 2));
    log("pick", `${clips.length} clips from ${path.relative(process.cwd(), picksSource)} (--repick to ask Claude again)`);
    for (const c of clips) log("pick", `  ${fmtTime(c.start)}-${fmtTime(c.end)}  [${c.score}/10] ${c.title}`);
  } else {
    if (agent === "claude" && process.env.ANTHROPIC_API_KEY && !(process.env.CAPY_USE_API_KEY ?? process.env.CLIPRUN_USE_API_KEY)) {
      log("pick", "ignoring ANTHROPIC_API_KEY so this uses your Claude plan (CAPY_USE_API_KEY=1 to use the key)");
    }
    log("pick", `asking ${agentSpec(agent).name}${model ? ` (${model})` : ""} for ${count} clips (${minSec}-${maxSec}s)`);
    const res = await pickClips(words, meta, {
      count,
      minSec,
      maxSec,
      agent,
      model,
      focus: v.focus,
      onRetry: (m) => log("pick", m),
    });
    clips = res.clips;
    await writeFile(clipsFile, JSON.stringify({ video: meta.url, agent, model, clips, raw: res.raw }, null, 2));
    log("pick", `${clips.length} clips in ${(res.durationMs / 1000).toFixed(1)}s (~$${res.costUsd.toFixed(3)} API-equivalent, billed to your plan)`);
    for (const c of clips) log("pick", `  ${fmtTime(c.start)}-${fmtTime(c.end)}  [${c.score}/10] ${c.title}`);
  }
  if (v["pick-only"]) {
    log("done", `picks saved to ${path.relative(process.cwd(), clipsFile)}. Edit if you like, then run again without --pick-only`);
    return;
  }
  if (clips.length === 0) throw new Error("No usable clips were picked. Try --repick or a longer --max.");

  // 4. download sections + 5. render
  const segName = (c: Clip, i: number) => `${pad2(i + 1)}-${Math.round(c.start * 10)}-${Math.round(c.end * 10)}-${maxRes}p.src.mp4`;
  await pruneWork(workDir, new Set(clips.map(segName)));
  const enc = await detectEncoder("auto");
  log("render", `encoder: ${enc}, source up to ${maxRes}p, layout: ${v.layout}, style: ${v.style}, ${jobs} parallel`);
  const results = await pool(clips, jobs, async (c, i): Promise<RenderedClip> => {
    const n = pad2(i + 1);
    const src = path.join(workDir, segName(c, i));
    const out = path.join(jobDir, `${n}-${slug(c.title)}.mp4`);
    if (!(await exists(src))) {
      log("download", `${n} ${fmtTime(c.start)}-${fmtTime(c.end)}`);
      await rm(`${src}.part`, { force: true });
      await fetchSection(url, c.start, c.end, src, yt, maxRes);
    }
    const info = await probeVideo(src);
    log("render", `${n} ${c.title}  (source ${info.width}x${info.height} @ ${Math.round(info.fps)}fps)`);
    await renderClip(
      src,
      out,
      wordsInRange(words, c.start, c.end),
      {
        layout: v.layout as "center" | "blur",
        style: v.style!,
        encoder: "auto",
        captions,
        hook: hook ? { text: c.hook, seconds: Math.min(3, c.end - c.start) } : undefined,
      },
      path.join(workDir, `${n}.ass`),
    );
    await writePublishFiles(out, c);
    return { ...c, index: i + 1, file: out };
  });

  const done: RenderedClip[] = [];
  results.forEach((r, i) => {
    const c = clips[i]!;
    if (r.status === "fulfilled") done.push(r.value);
    else {
      done.push({ ...c, index: i + 1, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
      log("error", `${pad2(i + 1)} ${c.title}:\n${lastLines(r.reason, 4)}`);
    }
  });
  await writeFile(path.join(jobDir, "result.json"), JSON.stringify({ video: meta, clips: done }, null, 2));
  const ok = done.filter((d) => d.file).length;
  log("done", `${ok}/${clips.length} clips in ${path.relative(process.cwd(), jobDir) || jobDir} (each with a .jpg thumbnail and .txt title/description/hashtags)`);
  if (ok < clips.length) process.exitCode = 2;
}

function int(flag: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be a whole number from ${min} to ${max} (got "${raw}")`);
  return n;
}

/** First line of an error plus its last `n` meaningful lines (where yt-dlp/ffmpeg put the real cause). */
function lastLines(e: unknown, n: number): string {
  const lines = (e instanceof Error ? e.message : String(e)).split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= n + 1) return lines.join("\n");
  return [lines[0], ...lines.slice(-n)].join("\n");
}

/** Delete downloaded segments no longer referenced by clips.json, and partial downloads. */
async function pruneWork(workDir: string, keep: Set<string>) {
  for (const f of await readdir(workDir)) {
    if ((f.endsWith(".src.mp4") && !keep.has(f)) || /\.src\.mp4\.part/.test(f)) {
      await rm(path.join(workDir, f), { force: true });
    }
  }
}

/** Reuse an earlier run's folder for this video id (skips the metadata fetch). */
async function findJobDir(outRoot: string, id: string): Promise<string | null> {
  try {
    const hit = (await readdir(outRoot)).find((d) => d.endsWith(`-${id}`));
    if (hit && (await exists(path.join(outRoot, hit, "meta.json")))) return path.join(outRoot, hit);
  } catch {
    /* no output dir yet */
  }
  return null;
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function doctor() {
  const model = (process.env.CAPY_MODEL ?? process.env.CLIPRUN_MODEL) ?? DEFAULT_MODEL;
  const checks: [string, () => Promise<string>][] = [
    ["node", async () => process.version],
    ["yt-dlp", async () => (await run("yt-dlp", ["--version"])).stdout.trim()],
    ["ffmpeg", async () => {
      const v = (await run("ffmpeg", ["-version"])).stdout.split("\n")[0]!.replace("ffmpeg version ", "").split(" ")[0]!;
      const bin = resolveBin("ffmpeg");
      return bin === "ffmpeg" ? v : `${v} (${bin})`;
    }],
    ["captions", async () => {
      // real test render through the same code path as clips
      const dir = await mkdtemp(path.join(tmpdir(), "capy-check-"));
      try {
        const src = path.join(dir, "src.mp4");
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=1", "-f", "lavfi", "-i", "sine=d=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
        await renderClip(src, path.join(dir, "out.mp4"), [{ text: "test", start: 0.1, end: 0.6 }], { layout: "center", style: "bold", encoder: "auto", captions: true, hook: { text: "hook", seconds: 1 } });
        return "burned-in captions render ok";
      } catch (e) {
        const msg = (e as Error).message;
        return msg === NO_LIBASS ? `ERROR: ${msg}` : `ERROR: ${msg.split("\n").slice(-2).join(" ")}`;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }],
    ["encoder", async () => detectEncoder("auto")],
    ["whisper", async () =>
      (await hasCommand("mlx_whisper")) ? "mlx_whisper (optional fallback)" : (await hasCommand("whisper-cli")) ? "whisper-cli (optional fallback)" : "none — only needed for videos without captions"],
    [`claude`, async () => {
      const r = await askClaude(
        "Reply with the single word: ready",
        { model, tools: [], settingSources: [], persistSession: false, maxTurns: 1 },
        { timeoutMs: 60_000 },
      );
      return `${model} ok (${String(r.result).trim().slice(0, 20)})`;
    }],
  ];
  let bad = 0;
  for (const [name, fn] of checks) {
    if (name === "claude") process.stdout.write(`  … ${name.padEnd(12)} asking ${model}…\r`);
    try {
      const r = await fn();
      const fail = /MISSING|ERROR/.test(r);
      if (fail) bad++;
      console.log(`  ${fail ? "✗" : "✓"} ${name.padEnd(12)} ${r}`.padEnd(60));
    } catch (e) {
      bad++;
      console.log(`  ✗ ${name.padEnd(12)} ${(e as Error).message.split("\n")[0]}`.padEnd(60));
    }
  }
  console.log(bad ? `\n${bad} problem(s). Fix them, then run a clip.` : "\nAll good. Try: pnpm clip https://youtu.be/VIDEO_ID --pick-only");
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => {
  console.error(`\nerror: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
