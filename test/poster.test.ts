import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tick, type PosterDeps } from "../server/poster";
import { queue, resetQueueCache, upsertForRender } from "../server/queue";
import { AuthError } from "../server/accounts";
import { PlatformError, type PostOutcome } from "../server/platforms/types";
import type { Platform, QueueEntry } from "../lib/types";

let root: string;
let n = 0;
beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-poster-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++n));
  resetQueueCache();
});

const now = new Date("2026-09-23T20:00:00Z");
function seed(entries: { n: number; platform: Platform; slotAt: number; status?: QueueEntry["status"] }[]) {
  queue().mutate(() =>
    entries.flatMap((s) =>
      upsertForRender([], { jobId: "J", n: s.n, clipTitle: `c${s.n}`, videoUrl: "/v.mp4" }, [s.platform], now).map((e) => ({ ...e, status: s.status ?? ("scheduled" as const), slotAt: s.slotAt })),
    ),
  );
}
function deps(over: Partial<PosterDeps> = {}): PosterDeps & { posted: string[] } {
  const posted: string[] = [];
  return {
    posted,
    now: () => now,
    post: async (e) => {
      posted.push(e.key);
      return { kind: "posted", id: "x", url: "u" } as PostOutcome;
    },
    token: async () => "T",
    fileFor: () => ({ file: "/tmp/clip.mp4" }),
    paused: () => false,
    audienceTz: () => "America/New_York",
    ...over,
  };
}
const get = (key: string) => queue().list().find((e) => e.key === key)!;

describe("tick", () => {
  it("posts what is due, leaves future slots alone", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() - 60_000 }, { n: 2, platform: "tiktok", slotAt: now.getTime() + 3600_000 }]);
    const d = deps();
    await tick(d);
    expect(d.posted).toEqual(["J:1:youtube"]);
    expect(get("J:1:youtube").status).toBe("posted");
    expect(get("J:2:tiktok").status).toBe("scheduled");
  });
  it("does nothing while paused", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() - 60_000 }]);
    const d = deps({ paused: () => true });
    await tick(d);
    expect(d.posted).toEqual([]);
  });
  it("a missing clip file needs action instead of a post", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() }]);
    const d = deps({ fileFor: () => undefined });
    await tick(d);
    expect(d.posted).toEqual([]);
    expect(get("J:1:youtube")).toMatchObject({ status: "needs_action", error: "Clip file missing, re-render it" });
  });
  it("one post per platform at a time; overlapping ticks never post an entry twice", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() - 1000 }, { n: 2, platform: "youtube", slotAt: now.getTime() - 500 }]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const posted: string[] = [];
    const d = deps({
      post: async (e) => {
        posted.push(e.key);
        await gate;
        return { kind: "posted", id: "x" };
      },
    });
    const a = tick(d);
    const b = tick(d);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toEqual(["J:1:youtube"]);
    release();
    await Promise.all([a, b]);
    await tick(d);
    expect(posted).toEqual(["J:1:youtube", "J:2:youtube"]);
  });
  it("a retryable failure waits for its backoff", async () => {
    seed([{ n: 1, platform: "instagram", slotAt: now.getTime() }]);
    let calls = 0;
    const d = deps({
      post: async () => {
        calls++;
        throw new PlatformError("503", true);
      },
    });
    await tick(d);
    expect(get("J:1:instagram")).toMatchObject({ status: "failed", nextTryAt: now.getTime() + 2 * 60_000 });
    await tick(d);
    expect(calls).toBe(1);
    await tick({ ...d, now: () => new Date(now.getTime() + 3 * 60_000) });
    expect(calls).toBe(2);
  });
  it("an account that needs reconnecting blocks without calling the platform", async () => {
    seed([{ n: 1, platform: "tiktok", slotAt: now.getTime() }]);
    const d = deps({
      token: async () => {
        throw new AuthError("Reconnect TikTok");
      },
    });
    await tick(d);
    expect(d.posted).toEqual([]);
    expect(get("J:1:tiktok")).toMatchObject({ status: "needs_action", authBlocked: true });
  });
  it("a token the platform refuses flags the account for reconnecting", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() }]);
    const flagged: string[] = [];
    const d = deps({
      post: async () => {
        throw new PlatformError("Invalid credentials", false, true);
      },
      flagReconnect: (p) => void flagged.push(p),
    });
    await tick(d);
    expect(flagged).toEqual(["youtube"]);
    expect(get("J:1:youtube")).toMatchObject({ status: "needs_action", authBlocked: true });
  });
});
