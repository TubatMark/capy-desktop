import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  importCreators,
  listSubscriptions,
  readUploadDates,
} from "../server/subscriptions";
import {
  accountsFile,
  loadAccounts,
  publicAccounts,
  publicReadingAccount,
  resetAccountsCache,
  saveAccount,
  saveReadingAccount,
} from "../server/accounts";
import { startConnect, finishConnect, pendingConnect } from "../server/connect";
import { watcherTick } from "../server/watcher";
import { watch, mapChannel } from "../server/watch";
import { runtimeStore } from "../server/db/runtime";
import { SCOPES } from "../server/oauth";
const root = mkdtempSync(path.join(os.tmpdir(), "capy-subscriptions-"));
let serial = 0;
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++serial));
  resetAccountsCache();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const reading = (id = "reader-a") =>
  saveReadingAccount({
    clientId: "cid",
    clientSecret: "secret",
    account: { id, name: id },
    tokens: {
      accessToken: `read-${id}`,
      expiresAt: Date.now() + 3600_000,
      scope: SCOPES.youtube[1],
    },
  });
const channel = (n: number) => ({
  id: `UC${String(n).padStart(22, "0")}`,
  name: `Creator ${n}`,
  thumbnail: `https://example.com/${n}.jpg`,
});
const fixture = () => {
  const calls: URL[] = [];
  const f = vi.fn(async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u);
    const offset = Number(u.searchParams.get("pageToken") ?? 0);
    const channels = Array.from(
      { length: Math.min(50, 120 - offset) },
      (_, i) => channel(offset + i),
    );
    if (offset === 50) channels.push(channel(1));
    return new Response(
      JSON.stringify({
        items: channels.map((c) => ({
          snippet: {
            title: c.name,
            resourceId: { channelId: c.id },
            thumbnails: { default: { url: c.thumbnail } },
          },
        })),
        nextPageToken: offset + 50 < 120 ? String(offset + 50) : undefined,
      }),
    );
  }) as unknown as typeof fetch;
  return {
    calls,
    fetch: f,
    uploads: vi.fn(async () => [
      {
        id: "old-upload",
        title: "Existing upload",
        duration: 600,
        live: false,
      },
    ]),
  };
};
describe("read-only subscription import", () => {
  it("import_all_pages_without_duplicates", async () => {
    reading();
    const deps = fixture();
    const selectedIds = Array.from({ length: 120 }, (_, n) => channel(n).id);
    const result = await importCreators(
      {
        accountId: "reader-a",
        selectedIds: [...selectedIds, selectedIds[0]!],
        backfill: false,
        mode: "manual",
      },
      deps,
    );
    expect(result.imported.map((c) => c.id).sort()).toEqual(selectedIds.sort());
    expect(watch().get().channels).toHaveLength(120);
    expect(deps.calls.map((u) => u.searchParams.get("pageToken"))).toEqual([
      null,
      "50",
      "100",
    ]);
    expect(
      deps.calls.every(
        (u) =>
          u.pathname === "/youtube/v3/subscriptions" &&
          u.searchParams.get("mine") === "true",
      ),
    ).toBe(true);
    expect(deps.uploads).toHaveBeenCalledTimes(120);
  });
  it("import_never_enables_publication and preserves creator preferences on refresh", async () => {
    reading();
    const deps = fixture();
    saveAccount("youtube", {
      account: { id: "publisher", name: "Publisher" },
      tokens: { accessToken: "publish", expiresAt: Date.now() + 3600_000 },
      autoPost: false,
    });
    const before = readFileSync(accountsFile(), "utf8");
    const input = {
      accountId: "reader-a",
      selectedIds: [channel(1).id],
      backfill: false,
      mode: "manual" as const,
    };
    await importCreators(input, deps);
    const c = watch().get().channels[0]!;
    expect(c).toMatchObject({
      enabled: false,
      mode: "manual",
      seen: ["old-upload"],
      pending: [],
      sourceAccountId: "reader-a",
    });
    watch().mutate((w) =>
      mapChannel(w, c.id, (old) => ({
        ...old,
        enabled: true,
        mode: "automatic_drafts",
        settings: { ...old.settings, clips: 7 },
        pending: [{ id: "future", title: "Future", foundAt: 123 }],
      })),
    );
    const previous = watch().get().channels[0];
    const again = await importCreators(
      { ...input, mode: "automatic_drafts", backfill: true },
      deps,
    );
    expect(again.existing).toEqual([c.id]);
    expect(watch().get().channels[0]).toEqual(previous);
    expect(readFileSync(accountsFile(), "utf8")).toEqual(before);
    expect(loadAccounts().youtube.autoPost).toBe(false);
    expect(runtimeStore().list("publications")).toEqual([]);
    expect(statSync(accountsFile()).mode & 0o777).toBe(0o600);
  });
  it("existing publishing credentials are never assumed to be the reading source", async () => {
    saveAccount("youtube", {
      account: { id: "publisher", name: "Publisher" },
      tokens: { accessToken: "publish", expiresAt: Date.now() + 3600_000 },
    });
    expect(publicAccounts()[0]?.role).toBe("publishing");
    expect(publicReadingAccount().connected).toBe(false);
    await expect(
      listSubscriptions("publisher", undefined, fixture().fetch),
    ).rejects.toThrow(/reading account/i);
  });
  it("automatic drafts and backfill each require an explicit choice", async () => {
    reading();
    await importCreators(
      {
        accountId: "reader-a",
        selectedIds: [channel(2).id],
        mode: "automatic_drafts",
        backfill: true,
      },
      fixture(),
    );
    expect(watch().get().channels[0]).toMatchObject({
      enabled: true,
      mode: "automatic_drafts",
      pending: [{ id: "old-upload" }],
    });
    await expect(
      importCreators(
        {
          accountId: "reader-a",
          selectedIds: [channel(3).id],
          mode: "automatic_publish",
          backfill: false,
        } as never,
        fixture(),
      ),
    ).rejects.toThrow(/mode/i);
    await expect(
      importCreators(
        {
          accountId: "reader-a",
          selectedIds: [channel(3).id],
          mode: "manual",
        } as never,
        fixture(),
      ),
    ).rejects.toThrow(/backfill/i);
  });
  it("revoked access and revoked scope expose a reconnect action", async () => {
    reading();
    await expect(
      listSubscriptions(
        "reader-a",
        undefined,
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: { errors: [{ reason: "insufficientPermissions" }] },
              }),
              { status: 403 },
            ),
        ) as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ reconnect: true });
    expect(publicReadingAccount().needsReconnect).toBe(true);
    reading();
    saveReadingAccount({
      tokens: {
        accessToken: "no-scope",
        expiresAt: Date.now() + 3600_000,
        scope: "https://www.googleapis.com/auth/youtube.upload",
      },
    });
    await expect(
      listSubscriptions("reader-a", undefined, fixture().fetch),
    ).rejects.toMatchObject({ reconnect: true });
  });
  it("a different reading OAuth principal is visible and never alters publishing destinations", async () => {
    reading();
    saveAccount("youtube", {
      account: { id: "publisher", name: "Publisher" },
      tokens: { accessToken: "publish", expiresAt: Date.now() + 3600_000 },
    });
    const pin = {
      destinationAccountId: "publisher",
      revision: 17,
      approved: true,
    };
    runtimeStore().save("publications", "pinned-package", pin, 0);
    const before = readFileSync(accountsFile(), "utf8");
    const { url } = await startConnect("youtube", {
      listen: false,
      role: "reading",
    });
    expect(new URL(url).searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.readonly",
    );
    const state = pendingConnect("youtube", "reading")!.state;
    const f = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).includes("/token")
              ? {
                  access_token: "read-new",
                  expires_in: 3600,
                  scope: "https://www.googleapis.com/auth/youtube.readonly",
                }
              : { items: [{ id: "reader-b", snippet: { title: "Reader B" } }] },
          ),
        ),
    ) as unknown as typeof fetch;
    await finishConnect(
      "youtube",
      `http://127.0.0.1:53682/callback?code=fixture&state=${state}`,
      f,
      "reading",
    );
    expect(publicReadingAccount()).toMatchObject({
      role: "reading",
      connected: true,
      account: { id: "reader-b", name: "Reader B" },
    });
    expect(readFileSync(accountsFile(), "utf8")).toBe(before);
    expect(runtimeStore().get("publications", "pinned-package")?.value).toEqual(
      pin,
    );
    await expect(
      importCreators(
        {
          accountId: "reader-a",
          selectedIds: [channel(1).id],
          mode: "manual",
          backfill: false,
        },
        fixture(),
      ),
    ).rejects.toThrow(/reading account/i);
  });
  it.each(["manual", "automatic_drafts"] as const)(
    "no backfill survives a Shorts-heavy baseline in %s mode and allows later uploads",
    async (mode) => {
      reading();
      const importedAt = new Date("2026-10-10T08:00:00Z");
      const cutoff = importedAt.getTime();
      const shorts = Array.from({ length: 60 }, (_, n) => ({
        id: `short-${n}`,
        title: `Short ${n}`,
        live: false,
        duration: 30,
      }));
      const regular = Array.from({ length: 12 }, (_, n) => ({
        id: `regular-${n}`,
        title: `Regular ${n}`,
        live: false,
        duration: 600,
        publishedAt: cutoff - (n + 1) * 86400000,
      }));
      const f = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const resource = url.pathname.split("/").pop();
        if (resource === "subscriptions")
          return new Response(
            JSON.stringify({
              items: [
                {
                  snippet: {
                    title: channel(1).name,
                    resourceId: { channelId: channel(1).id },
                  },
                },
              ],
            }),
          );
        if (resource === "channels")
          return new Response(
            JSON.stringify({
              items: [
                {
                  contentDetails: {
                    relatedPlaylists: { uploads: "all-formats" },
                  },
                },
              ],
            }),
          );
        if (resource === "playlistItems")
          return new Response(
            JSON.stringify({
              items: shorts
                .slice(0, 50)
                .map((u) => ({
                  snippet: { title: u.title, resourceId: { videoId: u.id } },
                })),
            }),
          );
        if (resource === "videos" && url.searchParams.get("part") === "snippet")
          return new Response(
            JSON.stringify({
              items: url.searchParams
                .get("id")!
                .split(",")
                .map((id) => ({
                  id,
                  snippet: {
                    publishedAt: new Date(
                      id === "new-regular"
                        ? cutoff + 1
                        : id === "at-cutoff"
                          ? cutoff
                          : cutoff - 86400000,
                    ).toISOString(),
                  },
                })),
            }),
          );
        if (resource === "videos")
          return new Response(
            JSON.stringify({
              items: shorts
                .slice(0, 50)
                .map((u) => ({
                  id: u.id,
                  contentDetails: { duration: "PT30S" },
                })),
            }),
          );
        throw new Error(`Unexpected fixture ${url}`);
      }) as unknown as typeof fetch;
      await importCreators(
        {
          accountId: "reader-a",
          selectedIds: [channel(1).id],
          backfill: false,
          mode,
        },
        { fetch: f, now: () => importedAt },
      );
      expect(watch().get().channels[0]!.seen).toHaveLength(50);
      expect(watch().get().channels[0]!.discoveryAfter).toBe(cutoff);
      if (mode === "manual")
        watch().mutate((w) =>
          // A C1 creator saved before the explicit cutoff field still uses its original import time.
          mapChannel(w, channel(1).id, (c) => ({ ...c, enabled: true, discoveryAfter: undefined })),
        );
      let feed = regular;
      const created = vi.fn(async (_videoId: string) => {});
      const deps = {
        now: () => new Date(cutoff + 3600000),
        lock: () => "held" as const,
        list: vi.fn(async () => feed),
        dateUploads: (accountId: string, uploads: typeof regular) =>
          readUploadDates(accountId, uploads, f),
        createJob: created,
      };
      await watcherTick(deps, { force: true });
      const first = watch().get().channels[0]!;
      expect(first.pending).toEqual([]);
      expect(first.history).toEqual([]);
      expect(created).not.toHaveBeenCalled();
      feed = [
        {
          id: "at-cutoff",
          title: "Existing at boundary",
          live: false,
          duration: 600,
          publishedAt: cutoff,
        },
        ...regular,
      ];
      await watcherTick(deps, { force: true });
      expect(created).not.toHaveBeenCalled();
      feed = [
        {
          id: "new-regular",
          title: "Genuinely new regular upload",
          live: false,
          duration: 600,
          publishedAt: cutoff + 1,
        },
        ...regular,
      ];
      await watcherTick(deps, { force: true });
      expect(created).toHaveBeenCalledTimes(1);
      expect(created.mock.calls[0]![0]).toBe("new-regular");
      expect(
        watch()
          .get()
          .channels[0]!.history.map((h) => h.videoId),
      ).toEqual(["new-regular"]);
      expect(f).toHaveBeenCalledTimes(7);
    },
  );
  it("defers unknown publication dates visibly without marking seen and resolves them on the next check", async () => {
    reading();
    const now = new Date("2026-10-10T08:00:00Z");
    await importCreators(
      {
        accountId: "reader-a",
        selectedIds: [channel(1).id],
        mode: "automatic_drafts",
        backfill: false,
      },
      { ...fixture(), now: () => now },
    );
    const upload = {
      id: "undated",
      title: "Undated regular upload",
      duration: 600,
      live: false,
    };
    let publishedAt: string | undefined;
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ id: upload.id, snippet: { publishedAt } }],
          }),
        ),
    ) as unknown as typeof fetch;
    const created = vi.fn(async (_videoId: string) => {});
    const deps = {
      now: () => new Date(now.getTime() + 60000),
      lock: () => "held" as const,
      list: async () => [upload],
      dateUploads: (accountId: string, uploads: (typeof upload)[]) =>
        readUploadDates(accountId, uploads, f),
      createJob: created,
    };
    await watcherTick(deps, { force: true });
    const deferred = watch().get().channels[0]!;
    expect(deferred.lastError).toMatch(
      /Waiting for exact publication dates: Undated regular upload.*deferred/,
    );
    expect(deferred.seen).not.toContain(upload.id);
    expect(deferred.pending).toEqual([]);
    expect(deferred.history).toEqual([]);
    expect(created).not.toHaveBeenCalled();
    publishedAt = new Date(now.getTime() + 1).toISOString();
    await watcherTick(deps, { force: true });
    expect(created).toHaveBeenCalledWith(
      upload.id,
      expect.anything(),
      expect.anything(),
    );
    expect(watch().get().channels[0]!.lastError).toBeUndefined();
  });

  it("publication date enrichment rejects a changed source principal and leaves existing pending work intact", async () => {
    reading();
    const now = new Date("2026-10-10T08:00:00Z");
    await importCreators(
      {
        accountId: "reader-a",
        selectedIds: [channel(1).id],
        mode: "automatic_drafts",
        backfill: true,
      },
      { ...fixture(), now: () => now },
    );
    // Preserve the explicitly requested old-upload pending entry while the source changes during enrichment.
    const pending = watch().get().channels[0]!.pending;
    const f = vi.fn(async () => {
      reading("reader-b");
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "new",
              snippet: {
                publishedAt: new Date(now.getTime() + 1).toISOString(),
              },
            },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    await expect(
      readUploadDates(
        "reader-a",
        [{ id: "new", title: "New", duration: 600, live: false }],
        f,
      ),
    ).rejects.toMatchObject({ reconnect: true });
    expect(watch().get().channels[0]!.pending).toEqual(pending);
    expect(watch().get().channels[0]!.history).toEqual([]);
    await expect(
      readUploadDates(
        "reader-a",
        [{ id: "new", title: "New", duration: 600, live: false }],
        f,
      ),
    ).rejects.toMatchObject({ reconnect: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("explicit pending backfill survives the cutoff, and refreshing never changes it or creator preferences", async () => {
    reading();
    const now = new Date("2026-10-10T08:00:00Z");
    const input = {
      accountId: "reader-a",
      selectedIds: [channel(1).id],
      mode: "automatic_drafts" as const,
      backfill: true,
    };
    await importCreators(input, { ...fixture(), now: () => now });
    const original = watch().get().channels[0]!;
    await importCreators(
      { ...input, backfill: false, mode: "manual" },
      { ...fixture(), now: () => new Date(now.getTime() + 60000) },
    );
    expect(watch().get().channels[0]).toEqual(original);
    const created = vi.fn(async (_videoId: string) => {});
    await watcherTick(
      {
        now: () => now,
        lock: () => "held",
        list: async () => [],
        createJob: created,
      },
      { force: true },
    );
    expect(created).toHaveBeenCalledWith(
      "old-upload",
      expect.anything(),
      expect.anything(),
    );
    expect(watch().get().channels[0]!.history[0]!.videoId).toBe("old-upload");
  });

  it("never recursively imports the YouTube publishing destination", async () => {
    reading();
    saveAccount("youtube", {
      account: { id: channel(1).id, name: "Destination" },
    });
    const deps = fixture();
    await expect(
      importCreators(
        {
          accountId: "reader-a",
          selectedIds: [channel(1).id],
          mode: "automatic_drafts",
          backfill: true,
        },
        deps,
      ),
    ).rejects.toThrow(/publishing destination/);
    expect(deps.uploads).not.toHaveBeenCalled();
    expect(watch().get().channels).toEqual([]);
  });
  it("rejects unknown selected IDs and a reconnect during import without partial state", async () => {
    reading();
    await expect(
      importCreators(
        {
          accountId: "reader-a",
          selectedIds: [channel(999).id],
          backfill: false,
          mode: "manual",
        },
        fixture(),
      ),
    ).rejects.toThrow(/subscription/i);
    expect(watch().get().channels).toEqual([]);
    const deps = fixture();
    deps.uploads.mockImplementation(async () => {
      reading("reader-b");
      return [];
    });
    await expect(
      importCreators(
        {
          accountId: "reader-a",
          selectedIds: [channel(1).id],
          backfill: false,
          mode: "manual",
        },
        deps,
      ),
    ).rejects.toThrow(/changed|reading account/i);
    expect(watch().get().channels).toEqual([]);
  });
});
