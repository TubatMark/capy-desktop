import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveBin, run } from "./exec";
import type { VideoMeta, Word } from "./types";
import { parseJson3 } from "./captions";

export interface YtOpts {
  proxy?: string;
  cookies?: string;
  /** Read cookies straight from a browser profile, e.g. "chrome" or "safari". */
  cookiesFromBrowser?: string;
}

function common(o: YtOpts): string[] {
  const a: string[] = ["--no-warnings", "--no-playlist"];
  if (o.proxy) a.push("--proxy", o.proxy);
  if (o.cookies) a.push("--cookies", o.cookies);
  if (o.cookiesFromBrowser) a.push("--cookies-from-browser", o.cookiesFromBrowser);
  return a;
}

export function videoIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (u.hostname.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2]!;
    }
  } catch {
    /* not a URL */
  }
  return /^[A-Za-z0-9_-]{11}$/.test(url) ? url : null;
}

export async function fetchMeta(url: string, o: YtOpts = {}): Promise<VideoMeta> {
  const { stdout } = await run("yt-dlp", [...common(o), "--dump-single-json", "--skip-download", url]);
  const j = JSON.parse(stdout);
  return {
    id: j.id,
    title: j.title ?? j.id,
    channel: j.channel ?? j.uploader,
    duration: Number(j.duration ?? 0),
    url: j.webpage_url ?? url,
    language: j.language ?? undefined,
    subtitles: Object.keys(j.subtitles ?? {}),
    autoCaptions: Object.keys(j.automatic_captions ?? {}),
    heatmap: Array.isArray(j.heatmap)
      ? j.heatmap.map((p: { start_time: number; end_time: number; value: number }) => ({ start: p.start_time, end: p.end_time, value: p.value }))
      : undefined,
  };
}

/**
 * Pick the caption track whose words match what's actually spoken.
 * Tries the spoken language as given ("en-US") and its base ("en"): manual subs first,
 * then the original auto-caption track ("en-orig"), then plain auto ("en").
 * Never guesses among other languages' "-orig" tracks (YouTube lists many for dubbed videos).
 */
export function pickCaptionLang(meta: VideoMeta, lang?: string): { lang: string; auto: boolean } | null {
  const is = (l: string, p: string) => l === p || l.startsWith(p + "-") || l.startsWith(p + "_");
  const spoken = lang ?? meta.language;
  const tryLang = (c: string) => {
    const manual = meta.subtitles.find((l) => is(l, c));
    if (manual) return { lang: manual, auto: false };
    const auto = meta.autoCaptions.find((l) => l === `${c}-orig`) ?? meta.autoCaptions.find((l) => l === c);
    return auto ? { lang: auto, auto: true } : null;
  };
  for (const c of new Set([spoken, spoken?.split(/[-_]/)[0]].filter(Boolean) as string[])) {
    const hit = tryLang(c);
    if (hit) return hit;
  }
  // language unknown: a single original-speech track beats a possibly machine-translated "en"
  const origs = meta.autoCaptions.filter((l) => l.endsWith("-orig"));
  if (origs.length === 1) return { lang: origs[0]!, auto: true };
  const en = tryLang("en");
  if (en) return en;
  if (meta.subtitles[0]) return { lang: meta.subtitles[0], auto: false };
  if (meta.autoCaptions[0]) return { lang: meta.autoCaptions[0], auto: true };
  return null;
}

/** Download YouTube captions as json3 and parse into words. Returns null when the video has no captions. */
export async function fetchCaptions(
  url: string,
  dir: string,
  lang?: string,
  o: YtOpts = {},
  meta?: VideoMeta,
): Promise<Word[] | null> {
  meta ??= await fetchMeta(url, o);
  const pick = pickCaptionLang(meta, lang);
  if (!pick) return null;
  await mkdir(dir, { recursive: true });
  const args = [
    ...common(o),
    "--skip-download",
    pick.auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    pick.lang,
    "--sub-format",
    "json3",
    "-o",
    path.join(dir, "captions"),
    url,
  ];
  await run("yt-dlp", args);
  const files = (await readdir(dir)).filter((f) => f.startsWith("captions") && f.endsWith(".json3"));
  if (files.length === 0) return null;
  const raw = await readFile(path.join(dir, files[0]!), "utf8");
  const words = parseJson3(raw);
  return words.length > 0 ? words : null;
}

/** Download the full audio track (m4a) for Whisper fallback. */
export async function fetchAudio(url: string, out: string, o: YtOpts = {}): Promise<string> {
  await run("yt-dlp", [...common(o), "-f", "bestaudio[ext=m4a]/bestaudio", "-o", out, url]);
  return out;
}

/**
 * Download only [start, end] of the source, at the best resolution up to `maxRes`.
 * Uses --download-sections so a 1-hour source never comes down in full.
 *
 * Quality: a 9:16 crop of a 16:9 frame keeps only ~56% of its width, so a 1080p
 * source gets stretched 1.8x. A 4K source gets scaled *down* instead — much sharper.
 * yt-dlp must re-encode the section for a frame-accurate cut; that pass is made
 * near-lossless so the final render is the only real compression step.
 */
export async function fetchSection(
  url: string,
  start: number,
  end: number,
  out: string,
  o: YtOpts = {},
  maxRes = 2160,
): Promise<string> {
  const ffmpeg = resolveBin("ffmpeg");
  const intermediate =
    process.platform === "darwin"
      ? "-c:v h264_videotoolbox -b:v 80M -profile:v high -pix_fmt yuv420p -c:a aac -b:a 256k"
      : "-c:v libx264 -preset ultrafast -crf 12 -pix_fmt yuv420p -c:a aac -b:a 256k";
  await run("yt-dlp", [
    ...common(o),
    "-f",
    `bv*[height<=${maxRes}]+ba/b[height<=${maxRes}]/b`,
    "-S",
    `res:${maxRes},fps`,
    "--download-sections",
    `*${start.toFixed(2)}-${end.toFixed(2)}`,
    "--force-keyframes-at-cuts",
    "--downloader-args",
    `ffmpeg_o:${intermediate}`,
    ...(ffmpeg !== "ffmpeg" ? ["--ffmpeg-location", path.dirname(ffmpeg)] : []),
    "--merge-output-format",
    "mp4",
    "-o",
    out,
    url,
  ]);
  return out;
}

// ---------- channels (creator automation) ----------

export interface ChannelInfo {
  id: string;
  name: string;
  handle?: string;
  /** The channel's uploads tab. */
  url: string;
}
export interface Upload {
  id: string;
  title: string;
  /** Seconds; undefined while YouTube doesn't know yet (premieres) or for live streams. */
  duration?: number;
  /** Live now or scheduled: nothing to clip yet. */
  live: boolean;
}

/** The uploads tab for a channel URL, @handle or channel id; null for anything else (video links included). */
export function channelVideosUrl(input: string): string | null {
  const s = input.trim();
  if (/^@[\w.-]+$/.test(s)) return `https://www.youtube.com/${s}/videos`;
  if (/^UC[\w-]{22}$/.test(s)) return `https://www.youtube.com/channel/${s}/videos`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(@[\w.-]+|channel\/UC[\w-]{22}|c\/[^/]+|user\/[^/]+)/);
  return m ? `https://www.youtube.com/${m[1]}/videos` : null;
}

type Listing = { channel?: string; uploader?: string; channel_id?: string; uploader_id?: string; entries?: { id: string; title?: string; duration?: number | null; live_status?: string | null }[] };

export function parseChannel(j: Listing): ChannelInfo {
  const id = String(j.channel_id);
  const handle = j.uploader_id?.startsWith("@") ? j.uploader_id : undefined;
  return { id, name: j.channel ?? j.uploader ?? id, handle, url: `https://www.youtube.com/channel/${id}/videos` };
}

export function parseUploads(j: Listing): Upload[] {
  return (j.entries ?? [])
    .filter((e) => e?.id)
    .map((e) => ({ id: e.id, title: e.title ?? e.id, duration: typeof e.duration === "number" ? e.duration : undefined, live: e.live_status === "is_live" || e.live_status === "is_upcoming" }));
}

function flatArgs(o: YtOpts): string[] {
  const a = ["--no-warnings", "--flat-playlist", "-J"];
  if (o.proxy) a.push("--proxy", o.proxy);
  if (o.cookies) a.push("--cookies", o.cookies);
  if (o.cookiesFromBrowser) a.push("--cookies-from-browser", o.cookiesFromBrowser);
  return a;
}

/** Who a channel URL, @handle or video link belongs to. */
export async function resolveChannel(input: string, o: YtOpts = {}): Promise<ChannelInfo> {
  let url = channelVideosUrl(input);
  if (!url) {
    // a video link: find its channel
    if (!videoIdFromUrl(input.trim())) throw new Error("Paste a YouTube channel link, an @handle, or a video from that channel.");
    const meta = JSON.parse((await run("yt-dlp", [...common(o), "--dump-single-json", "--skip-download", input.trim()])).stdout);
    if (!meta.channel_id) throw new Error("Couldn't find the channel of that video.");
    url = `https://www.youtube.com/channel/${meta.channel_id}/videos`;
  }
  const { stdout } = await run("yt-dlp", [...flatArgs(o), "--playlist-end", "1", url]);
  const j = JSON.parse(stdout) as Listing;
  if (!j.channel_id) throw new Error("That doesn't look like a YouTube channel.");
  return parseChannel(j);
}

/** The newest `n` uploads of a channel, newest first. */
export async function listUploads(channelUrl: string, n: number, o: YtOpts = {}): Promise<Upload[]> {
  const { stdout } = await run("yt-dlp", [...flatArgs(o), "--playlist-end", String(n), channelUrl]);
  return parseUploads(JSON.parse(stdout) as Listing);
}
