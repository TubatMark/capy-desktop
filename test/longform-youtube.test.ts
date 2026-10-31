import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SLICE, sendSlice, setPublishTime, startUpload, uploadBody } from "../server/longform/youtube";

const file = (bytes: number) => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "capy-lf-")), "m.mp4");
  writeFileSync(f, Buffer.alloc(bytes));
  return f;
};

describe("long video upload", () => {
  it("is always Private at upload, with no #shorts in the title", async () => {
    let sent: { snippet: { title: string }; status: { privacyStatus: string; publishAt?: string } } | undefined;
    const fetchMock = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(null, { status: 200, headers: { location: "https://upload/s" } });
    }) as typeof fetch;
    expect(await startUpload({ fetch: fetchMock, token: "t" }, { title: "Top 10 Kai Cenat moments", description: "d", tags: [] }, 5)).toBe("https://upload/s");
    expect(sent!.status.privacyStatus).toBe("private");
    expect(sent!.status.publishAt).toBeUndefined();
    expect(sent!.snippet.title).toBe("Top 10 Kai Cenat moments");
    expect(uploadBody({ title: "x".repeat(200) }).snippet.title).toHaveLength(100);
  });

  it("resumes from where YouTube says it got to, and returns the id at the end", async () => {
    const size = 1000;
    const ranges: string[] = [];
    const fetchMock = (async (_u: string, init: RequestInit) => {
      const range = (init.headers as Record<string, string>)["Content-Range"]!;
      ranges.push(range);
      if (range.startsWith("bytes */")) return new Response(null, { status: 308, headers: { range: "bytes=0-399" } });
      return new Response(JSON.stringify({ id: "vid" }), { status: 200 });
    }) as typeof fetch;
    expect(await sendSlice({ fetch: fetchMock, token: "t" }, "s", file(size), size)).toEqual({ offset: size, id: "vid" });
    expect(ranges).toEqual(["bytes */1000", "bytes 400-999/1000"]);
  });

  it("stops after one slice so other work can run", async () => {
    const size = SLICE + 64 * 1024 * 1024;
    let offset = 0;
    const fetchMock = (async (_u: string, init: RequestInit) => {
      const m = (init.headers as Record<string, string>)["Content-Range"]!.match(/bytes (\d+)-(\d+)\//);
      if (m) offset = Number(m[2]) + 1;
      return new Response(null, { status: 308, headers: offset ? { range: `bytes=0-${offset - 1}` } : {} });
    }) as typeof fetch;
    const f = path.join(mkdtempSync(path.join(tmpdir(), "capy-lf-")), "m.mp4");
    const { truncateSync, closeSync, openSync } = await import("node:fs");
    closeSync(openSync(f, "w"));
    truncateSync(f, size);
    const res = await sendSlice({ fetch: fetchMock, token: "t" }, "s", f, size);
    expect(res.id).toBeUndefined();
    expect(res.offset).toBe(SLICE);
  });

  it("surfaces YouTube's error", async () => {
    const fetchMock = (async () => new Response(JSON.stringify({ error: { message: "quotaExceeded" } }), { status: 403 })) as typeof fetch;
    await expect(setPublishTime({ fetch: fetchMock, token: "t" }, "v", 1)).rejects.toThrow(/quotaExceeded/);
  });
});
