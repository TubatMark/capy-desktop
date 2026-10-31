import { openAsBlob, readFileSync, statSync } from "node:fs";
import type { AudienceReport, LongVideo } from "../../lib/longform";

/**
 * YouTube for long videos, kept apart from the Shorts delivery path: no #shorts title, always Private at upload, and
 * the upload goes a slice at a time so posting keeps running in between.
 */
const API = "https://www.googleapis.com";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
/** Resumable uploads need multiples of 256 KiB. */
const CHUNK = 32 * 1024 * 1024;
/** How much one worker turn sends. */
export const SLICE = 320 * 1024 * 1024;

export interface YtDeps {
  fetch: typeof fetch;
  token: string;
}
const bearer = (d: YtDeps) => ({ Authorization: `Bearer ${d.token}` });

async function failure(what: string, r: Response) {
  const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  return Object.assign(new Error(`${what}: ${body.error?.message ?? r.statusText} (HTTP ${r.status})`), { status: r.status });
}

export function uploadBody(v: Pick<LongVideo, "title" | "description" | "tags">) {
  return {
    snippet: { title: v.title.slice(0, 100), description: v.description ?? "", tags: v.tags ?? [], categoryId: "24", defaultLanguage: "en", defaultAudioLanguage: "en" },
    status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
  };
}

export async function startUpload(d: YtDeps, v: Pick<LongVideo, "title" | "description" | "tags">, size: number): Promise<string> {
  const r = await d.fetch(`${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: { ...bearer(d), "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(size) },
    body: JSON.stringify(uploadBody(v)),
  });
  if (!r.ok) throw await failure("YouTube refused the upload", r);
  const session = r.headers.get("location");
  if (!session) throw new Error("YouTube gave no upload address");
  return session;
}

const nextOffset = (r: Response) => {
  const m = r.headers.get("range")?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
};

/** Ask how far an interrupted upload got. */
async function askOffset(d: YtDeps, session: string, size: number): Promise<{ offset: number; id?: string }> {
  const r = await d.fetch(session, { method: "PUT", headers: { ...bearer(d), "Content-Length": "0", "Content-Range": `bytes */${size}` } });
  if (r.status === 308) return { offset: nextOffset(r) };
  if (r.ok) return { offset: size, id: ((await r.json()) as { id: string }).id };
  throw await failure("The upload session ended", r);
}

/** Send up to one slice. Returns where it got to, and the video id once YouTube has the whole file. */
export async function sendSlice(d: YtDeps, session: string, file: string, size: number): Promise<{ offset: number; id?: string }> {
  const asked = await askOffset(d, session, size);
  if (asked.id) return asked;
  let offset = asked.offset;
  const stop = offset + SLICE;
  const blob = await openAsBlob(file);
  while (offset < size && offset < stop) {
    const end = Math.min(size, offset + CHUNK);
    const r = await d.fetch(session, {
      method: "PUT",
      headers: { ...bearer(d), "Content-Type": "video/mp4", "Content-Range": `bytes ${offset}-${end - 1}/${size}` },
      body: blob.slice(offset, end),
    });
    if (r.status === 308) offset = nextOffset(r);
    else if (r.ok) return { offset: size, id: ((await r.json()) as { id: string }).id };
    else throw await failure("The upload stopped", r);
  }
  return { offset };
}

export async function setThumbnail(d: YtDeps, id: string, file: string) {
  const r = await d.fetch(`${API}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(id)}&uploadType=media`, {
    method: "POST",
    headers: { ...bearer(d), "Content-Type": "image/jpeg", "Content-Length": String(statSync(file).size) },
    body: readFileSync(file),
  });
  if (!r.ok) throw await failure("YouTube refused the thumbnail", r);
}

export interface RemoteVideo {
  uploadStatus?: string;
  rejectionReason?: string;
  failureReason?: string;
  privacy?: string;
  publishAt?: number;
}

export async function readVideo(d: YtDeps, id: string): Promise<RemoteVideo | null> {
  const r = await d.fetch(`${API}/youtube/v3/videos?part=status&id=${encodeURIComponent(id)}`, { headers: bearer(d) });
  if (!r.ok) throw await failure("Could not read the video", r);
  const st = ((await r.json()) as { items?: { status: Record<string, string> }[] }).items?.[0]?.status;
  if (!st) return null;
  return {
    uploadStatus: st.uploadStatus,
    rejectionReason: st.rejectionReason,
    failureReason: st.failureReason,
    privacy: st.privacyStatus,
    publishAt: st.publishAt ? Date.parse(st.publishAt) : undefined,
  };
}

/** Set or clear the time a private video goes public. */
export async function setPublishTime(d: YtDeps, id: string, at: number | null) {
  const r = await d.fetch(`${API}/youtube/v3/videos?part=status`, {
    method: "PUT",
    headers: { ...bearer(d), "Content-Type": "application/json" },
    body: JSON.stringify({ id, status: { privacyStatus: "private", selfDeclaredMadeForKids: false, ...(at === null ? {} : { publishAt: new Date(at).toISOString() }) } }),
  });
  if (!r.ok) throw await failure("YouTube refused the time", r);
}

type Rows = (string | number)[][];
async function report(d: YtDeps, p: Record<string, string>): Promise<Rows> {
  const q = new URLSearchParams({ ids: "channel==MINE", ...p });
  const r = await d.fetch(`${ANALYTICS}?${q}`, { headers: bearer(d) });
  if (!r.ok) throw await failure("Could not read Analytics", r);
  return ((await r.json()) as { rows?: Rows }).rows ?? [];
}
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export async function videoViews(d: YtDeps, id: string, publishedAt: number, now: number) {
  const span = { startDate: day(publishedAt), endDate: day(now), metrics: "views" };
  const [all, ph] = await Promise.all([report(d, { ...span, filters: `video==${id}` }), report(d, { ...span, filters: `video==${id};country==PH` })]);
  return { views: Number(all[0]?.[0] ?? 0), philippinesViews: Number(ph[0]?.[0] ?? 0) };
}

const ageGender = (rows: Rows) => rows.map(([group, gender, pct]) => ({ group: String(group).replace(/^age/, ""), gender: String(gender), pct: Number(pct) }));

/** Who watches, over the channel's life. Hour of day isn't available in these reports. */
export async function readAudience(d: YtDeps, now: number): Promise<AudienceReport> {
  const span = { startDate: "2020-01-01", endDate: day(now) };
  const [countries, total, ages, phAges] = await Promise.all([
    report(d, { ...span, metrics: "views,averageViewPercentage", dimensions: "country", sort: "-views", maxResults: "10" }),
    report(d, { ...span, metrics: "views" }),
    report(d, { ...span, metrics: "viewerPercentage", dimensions: "ageGroup,gender", sort: "-viewerPercentage" }),
    report(d, { ...span, metrics: "viewerPercentage", dimensions: "ageGroup,gender", filters: "country==PH", sort: "-viewerPercentage" }),
  ]);
  return {
    fetchedAt: now,
    totalViews: Number(total[0]?.[0] ?? 0),
    countries: countries.map(([country, views, pct]) => ({ country: String(country), views: Number(views), avgViewPct: Number(pct) })),
    ageGender: ageGender(ages),
    philippinesAgeGender: ageGender(phAges),
  };
}
