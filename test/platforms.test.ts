import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { postYouTube } from "../server/platforms/youtube";
import { postInstagram } from "../server/platforms/instagram";
import { postTikTok } from "../server/platforms/tiktok";
import { httpError, PlatformError } from "../server/platforms/types";

const dir = mkdtempSync(path.join(tmpdir(), "capy-plat-"));
const file = path.join(dir, "clip.mp4");
const thumb = path.join(dir, "clip.jpg");
beforeAll(() => {
  writeFileSync(file, Buffer.alloc(1024, 1));
  writeFileSync(thumb, Buffer.alloc(10, 2));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
function stub(answers: ((c: Call) => Response)[]) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    const c: Call = { url: String(url), method: init.method ?? "GET", headers: Object.fromEntries(h.entries()), body: init.body };
    calls.push(c);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call ${c.method} ${c.url}`);
    return next(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
const ctx = (f: typeof fetch) => ({ token: "T", fetch: f, sleep: async () => {}, log: () => {} });
const job = { file, thumbFile: thumb, thumbAt: 1.4, text: { title: "Title", description: "Desc", tags: ["a"], caption: "Cap #a" } };

describe("youtube", () => {
  const init = json({}, 200, { location: "https://upload.example/session1" });
  it("uploads public, sets the thumbnail, waits for processing, returns the Shorts link", async () => {
    const { f, calls } = stub([init, json({ id: "abc" }), json({}), json({ items: [{ status: { uploadStatus: "uploaded", privacyStatus: "public" } }] }), json({ items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] })]);
    const out = await postYouTube(job, ctx(f));
    expect(calls[0]!.url).toContain("upload/youtube/v3/videos?uploadType=resumable&part=snippet,status");
    expect(calls[0]!.headers["x-upload-content-length"]).toBe("1024");
    const meta = JSON.parse(String(calls[0]!.body));
    expect(meta.snippet.title).toBe("Title");
    expect(meta.status.privacyStatus).toBe("public");
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toBe("https://upload.example/session1");
    expect(calls[2]!.url).toContain("thumbnails/set?videoId=abc");
    expect(out).toEqual({ kind: "posted", id: "abc", url: "https://youtube.com/shorts/abc" });
  });
  it("forced private → needs_action pointing at YouTube Studio", async () => {
    const { f } = stub([init, json({ id: "abc" }), json({}), json({ items: [{ status: { uploadStatus: "processed", privacyStatus: "private" } }] })]);
    const out = await postYouTube(job, ctx(f));
    expect(out.kind).toBe("needs_action");
    expect(out.kind === "needs_action" && out.note).toContain("YouTube Studio");
    expect(out.url).toContain("studio.youtube.com/video/abc");
  });
  it("a refused thumbnail doesn't fail the post", async () => {
    const { f } = stub([init, json({ id: "abc" }), json({ error: { message: "no" } }, 403), json({ items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] })]);
    expect((await postYouTube(job, ctx(f))).kind).toBe("posted");
  });
  it("rejected upload → non-retryable PlatformError", async () => {
    const { f } = stub([init, json({ id: "abc" }), json({}), json({ items: [{ status: { uploadStatus: "rejected", rejectionReason: "duplicate" } }] })]);
    const e = await postYouTube(job, ctx(f)).catch((x) => x);
    expect(e).toBeInstanceOf(PlatformError);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("duplicate");
  });
});

describe("instagram", () => {
  it("creates a resumable REELS container, uploads the file, waits, publishes, returns the permalink", async () => {
    const { f, calls } = stub([
      json({ id: "c1", uri: "https://rupload.facebook.com/ig-api-upload/v24.0/c1" }),
      json({ success: true }),
      json({ status_code: "IN_PROGRESS" }),
      json({ status_code: "FINISHED" }),
      json({ id: "m1" }),
      json({ permalink: "https://www.instagram.com/reel/x/" }),
    ]);
    const out = await postInstagram(job, { ...ctx(f), igUserId: "IG1" });
    expect(calls[0]!.url).toContain("graph.facebook.com/v24.0/IG1/media");
    const form = new URLSearchParams(String(calls[0]!.body));
    expect(form.get("media_type")).toBe("REELS");
    expect(form.get("upload_type")).toBe("resumable");
    expect(form.get("caption")).toBe("Cap #a");
    expect(form.get("thumb_offset")).toBe("1400");
    expect(calls[1]!.url).toBe("https://rupload.facebook.com/ig-api-upload/v24.0/c1");
    expect(calls[1]!.headers).toMatchObject({ authorization: "OAuth T", offset: "0", file_size: "1024" });
    expect(calls[4]!.url).toContain("IG1/media_publish");
    expect(out).toEqual({ kind: "posted", id: "m1", url: "https://www.instagram.com/reel/x/" });
  });
  it("container ERROR → non-retryable PlatformError", async () => {
    const { f } = stub([json({ id: "c1" }), json({ success: true }), json({ status_code: "ERROR", status: "Video too short" })]);
    const e = await postInstagram(job, { ...ctx(f), igUserId: "IG1" }).catch((x) => x);
    expect(e).toBeInstanceOf(PlatformError);
    expect(e.retryable).toBe(false);
  });
});

describe("tiktok", () => {
  it("inbox: inits a FILE_UPLOAD, PUTs the bytes, waits for SEND_TO_USER_INBOX", async () => {
    const { f, calls } = stub([
      json({ data: { publish_id: "p1", upload_url: "https://up.example/1" }, error: { code: "ok" } }),
      () => new Response(null, { status: 201 }),
      json({ data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } }),
      json({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } }),
    ]);
    const out = await postTikTok(job, { ...ctx(f), mode: "inbox" });
    expect(calls[0]!.url).toContain("/v2/post/publish/inbox/video/init/");
    expect(JSON.parse(String(calls[0]!.body)).source_info).toEqual({ source: "FILE_UPLOAD", video_size: 1024, chunk_size: 1024, total_chunk_count: 1 });
    expect(calls[1]!.headers["content-range"]).toBe("bytes 0-1023/1024");
    expect(out.kind).toBe("needs_action");
    expect(out.kind === "needs_action" && out.note).toContain("inbox");
  });
  it("direct: uses the allowed privacy level and says so when it isn't public", async () => {
    const { f, calls } = stub([
      json({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } }),
      json({ data: { publish_id: "p2", upload_url: "https://up.example/2" }, error: { code: "ok" } }),
      () => new Response(null, { status: 201 }),
      json({ data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } }),
    ]);
    const out = await postTikTok(job, { ...ctx(f), mode: "direct" });
    const body = JSON.parse(String(calls[1]!.body));
    expect(calls[1]!.url).toContain("/v2/post/publish/video/init/");
    expect(body.post_info.privacy_level).toBe("SELF_ONLY");
    expect(body.post_info.title).toBe("Cap #a");
    expect(body.post_info.video_cover_timestamp_ms).toBe(1400);
    expect(out).toMatchObject({ kind: "posted", note: "Posted as private (app not audited)" });
  });
  it("an error code in the body becomes a PlatformError (auth for a bad token)", async () => {
    const { f } = stub([json({ data: {}, error: { code: "access_token_invalid", message: "bad" } }, 401)]);
    const e = await postTikTok(job, { ...ctx(f), mode: "inbox" }).catch((x) => x);
    expect(e).toBeInstanceOf(PlatformError);
    expect(e.auth).toBe(true);
  });
});

describe("httpError", () => {
  it("maps status codes", () => {
    expect(httpError(new Response(null, { status: 401 }), {}).auth).toBe(true);
    expect(httpError(new Response(null, { status: 429 }), {}).retryable).toBe(true);
    expect(httpError(new Response(null, { status: 503 }), {}).retryable).toBe(true);
    const bad = httpError(new Response(null, { status: 400 }), { error: { message: "nope" } });
    expect(bad.retryable).toBe(false);
    expect(bad.auth).toBe(false);
    expect(bad.message).toContain("nope");
  });
});
