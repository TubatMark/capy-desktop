import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { importCreators, listSubscriptions } from "../server/subscriptions";
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
