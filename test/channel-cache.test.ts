import { afterEach, beforeEach, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { saveAccount, resetAccountsCache } from "../server/accounts";
import {
  channelState,
  channelFile,
  loadSnapshot,
  type ChannelDeps,
} from "../server/channel";
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "capy-channel-cache-"));
  process.env.CAPY_DATA_DIR = root;
  resetAccountsCache();
  saveAccount("youtube", {
    account: { id: "channel-A", name: "A" },
    clientId: "client-X",
    clientSecret: "secret-X",
    connectedAt: 1,
    tokens: {
      accessToken: "fixture",
      expiresAt: Date.now() + 86400000,
      scope: "https://www.googleapis.com/auth/youtube.readonly",
    },
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const deps = (f: typeof fetch): ChannelDeps => ({
  now: () => new Date(),
  token: async () => "fixture",
  fetch: f,
});
const good = () =>
  deps(
    (async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "channel-A",
              snippet: { title: "A" },
              statistics: { viewCount: "9" },
            },
          ],
        }),
      )) as typeof fetch,
  );
const failed = () =>
  deps(
    (async () =>
      new Response(JSON.stringify({ error: { message: "Fixture offline" } }), {
        status: 503,
      })) as typeof fetch,
  );
it("same-channel client replacement purges old snapshot and failed refresh cannot revive it", async () => {
  expect((await channelState({}, good())).snapshot?.channel.views).toBe(9);
  expect(existsSync(channelFile())).toBe(true);
  saveAccount("youtube", { clientId: "client-Y" });
  expect(await loadSnapshot()).toBeNull();
  expect(existsSync(channelFile())).toBe(false);
  const state = await channelState({}, failed());
  expect(state.snapshot).toBeNull();
  expect(state.error).toBeTruthy();
});
it("disconnect/reconnect cannot revive the same channel cache, even with unchanged connectedAt", async () => {
  await channelState({}, good());
  saveAccount("youtube", { tokens: null });
  saveAccount("youtube", {
    tokens: {
      accessToken: "reconnected-fixture",
      expiresAt: Date.now() + 86400000,
      scope: "https://www.googleapis.com/auth/youtube.readonly",
    },
  });
  expect(await loadSnapshot()).toBeNull();
  expect((await channelState({}, failed())).snapshot).toBeNull();
});
it("legacy unbound cache is rejected while ordinary same-client token refresh preserves a bound cache", async () => {
  await channelState({}, good());
  const original = readFileSync(channelFile(), "utf8");
  saveAccount("youtube", {
    tokens: {
      accessToken: "ordinary-refresh",
      expiresAt: Date.now() + 86400000,
      scope: "https://www.googleapis.com/auth/youtube.readonly",
    },
  });
  expect((await loadSnapshot())?.channel.views).toBe(9);
  const snapshot = JSON.parse(original);
  delete snapshot.cacheBinding;
  writeFileSync(channelFile(), JSON.stringify(snapshot));
  expect(await loadSnapshot()).toBeNull();
});
it("held old-client response cannot resurrect the purged cache after same-channel replacement", async () => {
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (started = r));
  const request = channelState(
    {},
    deps((async () => {
      started();
      await held;
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "channel-A",
              snippet: { title: "A" },
              statistics: { viewCount: "88" },
            },
          ],
        }),
      );
    }) as typeof fetch),
  );
  await ready;
  saveAccount("youtube", { clientSecret: "secret-Y" });
  release();
  const state = await request;
  expect(state.snapshot).toBeNull();
  expect(existsSync(channelFile())).toBe(false);
});
it("corrupt disposable channel cache does not prevent token removal", async () => {
  writeFileSync(channelFile(), "{invalid cache");
  expect(await loadSnapshot()).toBeNull();
  expect(() => saveAccount("youtube", { tokens: null })).not.toThrow();
  expect(existsSync(channelFile())).toBe(false);
});
it("cross-process credential replacement fences a held channel response and purges its old bound file", async () => {
  await channelState({}, good());
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (started = r));
  const request = channelState(
    { refresh: true },
    deps((async () => {
      started();
      await held;
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "channel-A",
              snippet: { title: "A" },
              statistics: { viewCount: "88" },
            },
          ],
        }),
      );
    }) as typeof fetch),
  );
  await ready;
  execFileSync(
    "node",
    [
      "--experimental-sqlite",
      "--import",
      "tsx",
      "test/fixtures/channel-cache-account-child.ts",
    ],
    {
      env: {
        ...process.env,
        CAPY_DATA_DIR: root,
        CAPY_AI_ALLOW_CLOUD: "false",
      },
      stdio: "pipe",
      timeout: 30000,
    },
  );
  release();
  const state = await request;
  expect(state.snapshot).toBeNull();
  expect(await loadSnapshot()).toBeNull();
  expect(existsSync(channelFile())).toBe(false);
});
