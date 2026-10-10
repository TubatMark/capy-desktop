import { DEFAULT_CREATOR_POLICY } from "../lib/creator-policy";
import { saveCreatorPolicy } from "../server/automation-policy";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reconcileCreator,
  discoveryState,
} from "../server/discovery/reconcile";
import { checkVideoReadiness } from "../server/discovery/readiness";
import {
  saveAccount,
  saveReadingAccount,
  resetAccountsCache,
} from "../server/accounts";
import { addChannel, watch, mapChannel } from "../server/watch";
import { runtimeStore } from "../server/db/runtime";
import { watcherTick } from "../server/watcher";

const root = mkdtempSync(path.join(os.tmpdir(), "capy-discovery-"));
let serial = 0;
const id = `UC${"1".repeat(22)}`;
const now = 1_800_000_000_000;
const reader = () =>
  saveReadingAccount({
    account: { id: "reader", name: "Reader" },
    tokens: {
      accessToken: "read",
      expiresAt: Date.now() + 3_600_000,
      scope: "https://www.googleapis.com/auth/youtube.readonly",
    },
  });
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++serial));
  resetAccountsCache();
  reader();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function creator(channelId = id) {
  watch().mutate((f) =>
    mapChannel(
      addChannel(
        f,
        {
          id: channelId,
          name: channelId,
          url: `https://www.youtube.com/channel/${channelId}/videos`,
        },
        [],
        { now: new Date(now) },
      ),
      channelId,
      (c) => ({ ...c, sourceAccountId: "reader", discoveryAfter: now }),
    ),
  );
}
const video = (n: number, extra = {}) => ({
  id: `v${String(n).padStart(10, "0")}`,
  snippet: {
    title: `Video ${n}`,
    channelId: id,
    publishedAt: new Date(now + n + 1).toISOString(),
    liveBroadcastContent: "none",
  },
  contentDetails: { duration: "PT10M" },
  status: { privacyStatus: "public", uploadStatus: "processed" },
  ...extra,
});
function api(count = 40) {
  let failed = false;
  let failPage = false;
  const calls: URL[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const resource = url.pathname.split("/").pop();
    if (resource === "channels")
      return Response.json({
        items: [
          { contentDetails: { relatedPlaylists: { uploads: "uploads" } } },
        ],
      });
    if (resource === "playlistItems") {
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      if (failPage && offset === 15 && !failed) {
        failed = true;
        return Response.json(
          { error: { message: "failed second page" } },
          { status: 503 },
        );
      }
      return Response.json({
        items: Array.from({ length: Math.min(15, count - offset) }, (_, i) => ({
          snippet: {
            resourceId: { videoId: video(count - offset - i - 1).id },
          },
        })),
        nextPageToken: offset + 15 < count ? String(offset + 15) : undefined,
      });
    }
    return Response.json({
      items: (url.searchParams.get("id") ?? "")
        .split(",")
        .map((v) => video(Number(v.slice(1)))),
    });
  }) as unknown as typeof fetch;
  return {
    fetch: fetcher,
    calls,
    now: () => new Date(now + 1000),
    fail: () => {
      failPage = true;
    },
  };
}
it("outage_recovers_more_than_twelve without advancing a partial success watermark", async () => {
  creator();
  const deps = api();
  deps.fail();
  const first = await reconcileCreator(id, new AbortController().signal, deps);
  expect(first.complete).toBe(false);
  expect(watch().get().channels[0]!.pending).toHaveLength(15);
  expect(discoveryState(id).lastSuccessAt).toBeUndefined();
  expect(discoveryState(id).nextAttemptAt).toBeGreaterThan(now + 1000);
  const failedCalls = deps.calls.length;
  await reconcileCreator(id, new AbortController().signal, deps);
  expect(deps.calls).toHaveLength(failedCalls);
  const recovered = await reconcileCreator(id, new AbortController().signal, {
    ...deps,
    force: true,
  });
  expect(recovered.complete).toBe(true);
  expect(watch().get().channels[0]!.pending).toHaveLength(40);
  expect(
    new Set(
      watch()
        .get()
        .channels[0]!.pending.map((p) => p.id),
    ).size,
  ).toBe(40);
  expect(
    watch()
      .get()
      .channels[0]!.pending.map((p) => p.id),
  ).toEqual(Array.from({ length: 40 }, (_, n) => video(n).id));
  watch().mutate((f) =>
    mapChannel(f, id, (c) => ({ ...c, seen: [], pending: [], history: [] })),
  );
  await reconcileCreator(id, new AbortController().signal, {
    ...deps,
    force: true,
  });
  expect(watch().get().channels[0]!.pending).toEqual([]);
  expect(runtimeStore().list("discovery-videos")).toHaveLength(40);
});
it("preserves import cutoff across every page, defers missing exact dates, and preserves explicit backfill", async () => {
  creator();
  watch().mutate((f) =>
    mapChannel(f, id, (c) => ({
      ...c,
      discoveryAfter: undefined,
      pending: [{ id: "backfill", title: "Explicit", foundAt: now }],
    })),
  );
  const deps = api(40);
  const transport = deps.fetch;
  deps.fetch = (async (input, init) => {
    const res = await transport(input, init);
    const body = await res.json();
    if (String(input).includes("/videos?"))
      body.items = body.items.map((v: ReturnType<typeof video>) => ({
        ...v,
        snippet: {
          ...v.snippet,
          publishedAt:
            Number(v.id.slice(1)) < 20
              ? new Date(now).toISOString()
              : undefined,
        },
      }));
    return Response.json(body);
  }) as typeof fetch;
  await reconcileCreator(id, new AbortController().signal, deps);
  const ch = watch().get().channels[0]!;
  expect(ch.pending.map((p) => p.id)).toEqual(["backfill"]);
  expect(ch.seen).not.toContain(video(20).id);
  expect(ch.lastError).toMatch(/publication/i);
  await reconcileCreator(id, new AbortController().signal, {
    ...deps,
    fetch: transport,
    force: true,
  });
  expect(watch().get().channels[0]!.pending).toHaveLength(21);
});
it("source principal changes reject a page and never overwrite provenance", async () => {
  creator();
  const deps = api();
  const transport = deps.fetch;
  deps.fetch = (async (input, init) => {
    const r = await transport(input, init);
    if (String(input).includes("/videos?"))
      saveReadingAccount({ account: { id: "other", name: "Other" } });
    return r;
  }) as typeof fetch;
  expect(
    (await reconcileCreator(id, new AbortController().signal, deps)).complete,
  ).toBe(false);
  expect(watch().get().channels[0]!.pending).toEqual([]);
  expect(watch().get().channels[0]!.sourceAccountId).toBe("reader");
});
it("one_slow_channel_does_not_block_others and failures back off", async () => {
  creator();
  const other = `UC${"2".repeat(22)}`;
  creator(other);
  const started: string[] = [];
  await watcherTick(
    {
      now: () => new Date(now + 1000),
      lock: () => "held",
      list: async () => [],
      deadlineMs: 30,
      reconcile: async (channelId, signal) => {
        if (channelId === id)
          return new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("deadline")),
              { once: true },
            ),
          );
        started.push(channelId);
        return { complete: true, channelId, discovered: 0 };
      },
      createJob: async () => {},
    },
    { force: true },
  );
  expect(started).toEqual([other]);
  expect(watch().get().channels[0]!.lastError).toMatch(/deadline|timeout/i);
});
it("readiness distinguishes live, premiere, private, deleted, duration filter and destination", async () => {
  const result = async (item: unknown) =>
    checkVideoReadiness(video(1).id, {
      accountId: "reader",
      channelId: id,
      minVideoSec: 240,
      now: () => new Date(now),
      fetch: (async () =>
        Response.json({ items: item ? [item] : [] })) as typeof fetch,
    });
  expect(await result(video(1))).toMatchObject({ status: "ready" });
  expect(
    await result(
      video(1, {
        snippet: { ...video(1).snippet, liveBroadcastContent: "live" },
      }),
    ),
  ).toMatchObject({
    status: "wait-until",
    reason: expect.stringMatching(/live/i),
  });
  expect(
    await result(
      video(1, {
        snippet: { ...video(1).snippet, liveBroadcastContent: "upcoming" },
      }),
    ),
  ).toMatchObject({
    status: "wait-until",
    reason: expect.stringMatching(/premiere/i),
  });
  expect(
    await result(video(1, { status: { privacyStatus: "private" } })),
  ).toMatchObject({
    status: "unavailable",
    reason: expect.stringMatching(/private/i),
  });
  expect(await result(undefined)).toMatchObject({ status: "unavailable" });
  expect(
    await result(video(1, { contentDetails: { duration: "PT1M" } })),
  ).toMatchObject({
    status: "excluded",
    reason: expect.stringMatching(/short|minimum/i),
  });
  saveAccount("youtube", { account: { id, name: "Destination" } });
  creator();
  expect(
    await reconcileCreator(id, new AbortController().signal, api()),
  ).toMatchObject({
    complete: true,
    discovered: 0,
    reason: expect.stringMatching(/destination/i),
  });
});
it("deadline bounds a transport that ignores abort, persists backoff and leaves the success watermark intact", async () => {
  creator();
  await reconcileCreator(id, new AbortController().signal, api(1));
  const success = discoveryState(id);
  const hung = (async () => new Promise<Response>(() => {})) as typeof fetch;
  const result = await reconcileCreator(id, new AbortController().signal, {
    fetch: hung,
    force: true,
    deadlineMs: 20,
    now: () => new Date(now + 2000),
  });
  expect(result.complete).toBe(false);
  expect(result.reason).toMatch(/timeout/i);
  expect(discoveryState(id).lastSuccessAt).toBe(success.lastSuccessAt);
  expect(discoveryState(id).watermark).toBe(success.watermark);
  expect(discoveryState(id).nextAttemptAt).toBeGreaterThan(now + 2000);
});
it("does not mutate after cancellation or start explicitly pending destination work", async () => {
  creator();
  const ac = new AbortController();
  ac.abort();
  await expect(reconcileCreator(id, ac.signal, api())).rejects.toBeDefined();
  expect(watch().get().channels[0]!.pending).toEqual([]);
  saveAccount("youtube", { account: { id, name: "Destination" } });
  watch().mutate((f) =>
    mapChannel(f, id, (c) => ({
      ...c,
      pending: [{ id: "backfill", title: "Explicit", foundAt: now }],
    })),
  );
  const createJob = vi.fn(async () => {});
  await watcherTick(
    {
      now: () => new Date(now),
      lock: () => "held",
      list: async () => [],
      createJob,
    },
    { force: true },
  );
  expect(createJob).not.toHaveBeenCalled();
  expect(watch().get().channels[0]!.pending).toHaveLength(1);
});
it("repeated catch-up creates exactly one real durable media work item per source revision without spending AI", async () => {
  creator();
  process.env.CAPY_OUTPUT = path.join(root, "fixture-output");
  const { jobs } = await import("../server/jobs");
  const { workQueue } = await import("../server/worker/api");
  const fixture = api();
  await reconcileCreator(id, new AbortController().signal, fixture);
  await reconcileCreator(id, new AbortController().signal, {
    ...fixture,
    force: true,
  });
  watch().mutate((f) => ({
    ...mapChannel(f, id, (c) => ({
      ...c,
      settings: { ...c.settings, perDay: 100 },
    })),
    maxPerDay: 100,
  }));
  // Catch-up deduplication is tested with explicit ample creator capacity; ordinary intake remains bounded.
  saveAccount("youtube", {account:{id:"fixture-destination",name:"Fixture"},tokens:{accessToken:"fixture",expiresAt:Date.now()+3600000},autoPost:true});
  saveCreatorPolicy(id,{...DEFAULT_CREATOR_POLICY,mode:"automatic_drafts",clips:1,dailyClipCap:100,destinationDailySlots:100,destinationAccountIds:["fixture-destination"]});
  for (let i = 0; i < 40; i++) {
    await watcherTick({
      now: () => new Date(now + 1000),
      lock: () => "held",
      list: async () => [],
      createJob: async (videoId, settings, automation) => {
        await jobs().create(
          `https://www.youtube.com/watch?v=${videoId}`,
          settings,
          { automation },
        );
      },
    });
    watch().mutate((f) =>
      mapChannel(f, id, (c) => ({
        ...c,
        history: c.history.map((h) => ({ ...h, status: "rendered" })),
      })),
    );
  }
  expect(
    workQueue()
      .list()
      .filter((w) => w.kind === "media"),
  ).toHaveLength(40);
  expect(
    new Set(
      workQueue()
        .list()
        .map((w) => `${w.workKey}:${w.inputRevision}`),
    ).size,
  ).toBe(40);
  expect(runtimeStore().list("ai-reservation")).toEqual([]);
  expect(runtimeStore().list("ai-cache")).toEqual([]);
});

it("deadline passes make durable pagination progress and expired cursors restart without duplicates", async () => {
  creator();
  const deps = api(75), transport = deps.fetch;
  const pageStarts: string[] = [];
  let expire = false;
  deps.fetch = (async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("playlistItems")) {
      const token = u.searchParams.get("pageToken") ?? "0";
      pageStarts.push(token);
      if (expire && token !== "0") {
        expire = false;
        return Response.json({ error: { message: "expired", errors: [{ reason: "invalidPageToken" }] } }, { status: 400 });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const response = await transport(input, init);
    const body = await response.json();
    if (u.pathname.endsWith("playlistItems") && u.searchParams.has("pageToken"))
      body.items.push({ contentDetails: { videoId: video(74).id } }); // provider page overlap
    if (u.pathname.endsWith("videos"))
      for (const item of body.items) item.snippet.title += " edited";
    return Response.json(body);
  }) as typeof fetch;
  const pass = () => reconcileCreator(id, new AbortController().signal, { ...deps, force: true, deadlineMs: 260 });
  expect((await pass()).complete).toBe(false);
  expect(discoveryState(id).watermark).toBeUndefined();
  expect(discoveryState(id).lastSuccessAt).toBeUndefined();
  const firstCursor = discoveryState(id).cursor;
  expect(firstCursor).toBeTruthy();
  const before = pageStarts.length;
  await pass();
  expect(pageStarts[before]).toBe(firstCursor);
  for (let n = 0; n < 8 && !discoveryState(id).lastSuccessAt; n++) await pass();
  expect(watch().get().channels[0]!.pending).toHaveLength(75);
  expect(discoveryState(id).lastSuccessAt).toBeTruthy();
  expect(discoveryState(id).cursor).toBeUndefined();
  const start = pageStarts.length;
  expect((await pass()).complete).toBe(true);
  expect(pageStarts.slice(start)).toEqual(["0"]); // prior complete boundary
  // A provider token can expire; explicitly restart and dedupe accepted IDs.
  runtimeStore().put("discovery-state", id, { failures: 0, cursor: "15", scan: { accountId: "reader", cutoff: now, headIds: [] } });
  expire = true;
  expect((await pass()).reason).toMatch(/cursor expired/);
  expect(discoveryState(id).cursor).toBeUndefined();
  for (let n = 0; n < 8 && !discoveryState(id).lastSuccessAt; n++) await pass();
  expect(watch().get().channels[0]!.pending).toHaveLength(75);
  expect(new Set(watch().get().channels[0]!.pending.map((p) => p.id)).size).toBe(75);
});
