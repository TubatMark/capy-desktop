import { publicationFixture } from "./publication-fixtures";
import { decide } from "../server/publication-policy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tick, type PosterDeps } from "../server/poster";
import { queue, resetQueueCache, upsertForRender } from "../server/queue";
import { AuthError } from "../server/accounts";
import { PlatformError, type PostOutcome } from "../server/platforms/types";
import type { Platform, QueueEntry } from "../lib/types";

let fixture: {file:string};
let root: string;
let n = 0;
beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-poster-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++n));
  resetQueueCache();
  fixture=publicationFixture();
});

const now = new Date("2026-09-23T20:00:00Z");
function seed(entries: { n: number; platform: Platform; slotAt: number; status?: QueueEntry["status"] }[]) {
  queue().mutate(() =>
    entries.flatMap((s) =>
      upsertForRender([], { publicationFiles:fixture, jobId: "J", n: s.n, start: 0, end: 30, clipTitle: `c${s.n}`, videoUrl: "/v.mp4" }, [s.platform], now).map((e) => ({ ...decide(e,false,now), status: s.status ?? ("scheduled" as const), slotAt: s.slotAt })),
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
    fileFor: async () => ({ file: fixture.file }),
    lock: () => "held",
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
    const d = deps({ fileFor: async () => "missing" });
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
  it("a clip that is rendering right now waits for the next tick instead of failing", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() }]);
    const d = deps({ fileFor: async () => "rendering" });
    await tick(d);
    expect(d.posted).toEqual([]);
    expect(get("J:1:youtube")).toMatchObject({ status: "scheduled", slotAt: now.getTime() });
  });
  it("a clip whose footage changed after approval is not posted", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() }]);
    const d = deps({ fileFor: async () => "changed" });
    await tick(d);
    expect(d.posted).toEqual([]);
    expect(get("J:1:youtube").status).toBe("needs_action");
    expect(get("J:1:youtube").error).toContain("changed");
  });
  it("a retry resumes from the saved upload checkpoint instead of uploading again", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() }]);
    const seen: (Record<string, string> | undefined)[] = [];
    let first = true;
    const d = deps({
      post: async (_e, job, _t, checkpoint) => {
        seen.push(job.resume);
        if (first) {
          first = false;
          checkpoint({ videoId: "v1" });
          throw new PlatformError("network", true);
        }
        return { kind: "posted", id: "v1" };
      },
    });
    await tick(d);
    expect(get("J:1:youtube").progress).toEqual({ videoId: "v1" });
    await tick({ ...d, now: () => new Date(now.getTime() + 3 * 60_000) });
    expect(seen).toEqual([undefined, { videoId: "v1" }]);
    expect(get("J:1:youtube").status).toBe("posted");
  });
  it("only the process holding the poster lock posts, and taking the lock recovers interrupted uploads", async () => {
    seed([{ n: 1, platform: "youtube", slotAt: now.getTime() - 1000, status: "posting" }]);
    const other = deps({ lock: () => "busy" });
    await tick(other);
    expect(other.posted).toEqual([]);
    expect(get("J:1:youtube").status).toBe("posting");
    const mine = deps({ lock: () => "acquired" });
    await tick(mine);
    expect(mine.posted).toEqual(["J:1:youtube"]);
    expect(get("J:1:youtube").history.map((h) => h.msg)).toContain("Interrupted, retrying");
  });
});

describe("last upload gate",()=>{
  it("changed bytes are refused immediately before upload",async()=>{
    seed([{n:1,platform:"youtube",slotAt:now.getTime()}]);
    const d=deps({token:async()=>{const {writeFileSync}=await import("node:fs");writeFileSync(fixture.file,"changed after scheduling");return "T";}});
    await tick(d);expect(d.posted).toEqual([]);expect(get("J:1:youtube").status).toBe("needs_action");
    expect(get("J:1:youtube").error).toContain("Media changed");
  });
  it("changed destination while refreshing token is refused",async()=>{
    seed([{n:1,platform:"youtube",slotAt:now.getTime()}]);
    const d=deps({token:async()=>{const {saveAccount}=await import("../server/accounts");saveAccount("youtube",{account:{id:"different",name:"Different"}});return "T";}});
    await tick(d);expect(d.posted).toEqual([]);expect(get("J:1:youtube").error).toContain("Destination account changed");
  });
  it("legacy scheduled entry without package is never uploaded",async()=>{
    seed([{n:1,platform:"youtube",slotAt:now.getTime()}]);queue().mutate(all=>all.map(e=>({...e,publishPackage:undefined,publicationDecision:undefined})));
    const d=deps();await tick(d);expect(d.posted).toEqual([]);expect(get("J:1:youtube").error).toContain("Missing publication revision");
  });
});

it("inbox-to-direct settings mutation prevents adapter calls until fresh decision",async()=>{
  seed([{n:1,platform:"tiktok",slotAt:now.getTime()}]);
  const {saveAccount}=await import("../server/accounts");saveAccount("tiktok",{mode:"direct"});
  const d=deps();await tick(d);expect(d.posted).toEqual([]);
  queue().mutate(all=>all.map(e=>({...decide(e,false,now),status:"scheduled",slotAt:now.getTime()})));
  await tick(d);expect(d.posted).toEqual(["J:1:tiktok"]);
});

it("executes the freshly checked snapshot rather than the pre-token entry",async()=>{
  seed([{n:1,platform:"tiktok",slotAt:now.getTime()}]);
  let executedTitle:string|undefined;
  let executedProgress:string|undefined;
  let executedMode:string|undefined;
  const d=deps({token:async()=>{
    queue().mutate(all=>all.map(e=>({...decide({...e,text:{title:"Fresh checked title"}},false,now),progress:{marker:"latest"}})));
    return "T";
  },post:async(e,job)=>{
    executedTitle=job.text.title;executedProgress=job.resume?.marker;executedMode=job.deliveryOptions?.mode;
    expect(e.text.title).toBe("Fresh checked title");
    return {kind:"posted",id:"fixture"};
  }});
  await tick(d);expect(executedTitle).toBe("Fresh checked title");expect(executedProgress).toBe("latest");expect(executedMode).toBe("inbox");
});
