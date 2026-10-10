import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  accountsFile,
  AuthError,
  getAccessToken,
  loadAccounts,
  publicAccounts,
  resetAccountsCache,
  saveAccount,
} from "../server/accounts";

let root: string;
let n = 0;
beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-accounts-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++n));
  resetAccountsCache();
});

const reply = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("accounts store", () => {
  it("writes 0600 and never exposes tokens or the full secret", () => {
    saveAccount("youtube", {
      clientId: "cid",
      clientSecret: "supersecret1234",
      tokens: {
        accessToken: "AT",
        refreshToken: "RT",
        expiresAt: Date.now() + 3600_000,
      },
    });
    expect(statSync(accountsFile()).mode & 0o777).toBe(0o600);
    const yt = publicAccounts().find((a) => a.platform === "youtube")!;
    expect(yt.configured).toBe(true);
    expect(yt.connected).toBe(true);
    expect(yt.clientSecret).toBe("••••1234");
    expect(JSON.stringify(publicAccounts())).not.toContain("AT");
    expect(JSON.stringify(publicAccounts())).not.toContain("RT");
  });
  it("lists every platform, unconfigured ones too", () => {
    expect(publicAccounts().map((a) => a.platform)).toEqual([
      "youtube",
      "instagram",
      "tiktok",
    ]);
    expect(publicAccounts()[1]!.connected).toBe(false);
  });
});

describe("getAccessToken", () => {
  const creds = { clientId: "cid", clientSecret: "sec" };
  it("returns the stored token when it is not about to expire", async () => {
    saveAccount("youtube", {
      ...creds,
      tokens: {
        accessToken: "AT",
        refreshToken: "RT",
        expiresAt: Date.now() + 3600_000,
      },
    });
    expect(await getAccessToken("youtube", reply({}, 500))).toBe("AT");
  });
  it("refreshes inside 5 minutes and saves the new token", async () => {
    saveAccount("youtube", {
      ...creds,
      tokens: {
        accessToken: "OLD",
        refreshToken: "RT",
        expiresAt: Date.now() + 60_000,
      },
    });
    expect(
      await getAccessToken(
        "youtube",
        reply({ access_token: "NEW", expires_in: 3600 }),
      ),
    ).toBe("NEW");
    resetAccountsCache();
    expect(loadAccounts().youtube.tokens!.accessToken).toBe("NEW");
    expect(loadAccounts().youtube.tokens!.refreshToken).toBe("RT"); // Google omits it on refresh: keep the old one
  });
  it("flags needsReconnect on invalid_grant", async () => {
    saveAccount("youtube", {
      ...creds,
      tokens: {
        accessToken: "OLD",
        refreshToken: "RT",
        expiresAt: Date.now() - 1,
      },
    });
    await expect(
      getAccessToken("youtube", reply({ error: "invalid_grant" }, 400)),
    ).rejects.toBeInstanceOf(AuthError);
    expect(loadAccounts().youtube.needsReconnect).toBe(true);
    expect(publicAccounts()[0]!.connected).toBe(false);
  });
  it("throws AuthError when not connected", async () => {
    await expect(getAccessToken("tiktok", reply({}))).rejects.toBeInstanceOf(
      AuthError,
    );
  });
  it("refreshes 30 minutes ahead so a long upload and processing wait don't outlive the token", async () => {
    saveAccount("youtube", {
      ...creds,
      tokens: {
        accessToken: "OLD",
        refreshToken: "RT",
        expiresAt: Date.now() + 20 * 60_000,
      },
    });
    expect(
      await getAccessToken(
        "youtube",
        reply({ access_token: "NEW", expires_in: 3600 }),
      ),
    ).toBe("NEW");
  });
  it("a failed renewal keeps using a token that still works, without asking to reconnect", async () => {
    saveAccount("instagram", {
      ...creds,
      tokens: { accessToken: "LONG", expiresAt: Date.now() + 3 * 86_400_000 },
    });
    expect(
      await getAccessToken(
        "instagram",
        reply({ error: { message: "Temporary hiccup", code: 2 } }, 400),
      ),
    ).toBe("LONG");
    expect(loadAccounts().instagram.needsReconnect).toBeUndefined();
  });
});

it("synchronizes refresh and refuses to save across an exact account reconnect", async () => {
  saveAccount("youtube", {
    clientId: "c",
    clientSecret: "s",
    account: { id: "old", name: "old" },
    tokens: { accessToken: "old-token", refreshToken: "r", expiresAt: 0 },
  });
  let release!: (r: Response) => void,
    calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Promise<Response>((r) => {
      release = r;
    });
  }) as typeof fetch;
  const a = getAccessToken("youtube", fetcher),
    b = getAccessToken("youtube", fetcher);
  await new Promise((r) => setTimeout(r, 10));
  expect(calls).toBe(1);
  saveAccount("youtube", {
    account: { id: "new", name: "new" },
    tokens: {
      accessToken: "new-token",
      refreshToken: "new-r",
      expiresAt: Date.now() + 3600000,
    },
  });
  release(Response.json({ access_token: "stale-result", expires_in: 3600 }));
  const results = await Promise.allSettled([a, b]);
  expect(results.every((r) => r.status === "rejected")).toBe(true);
  expect(loadAccounts().youtube.tokens?.accessToken).toBe("new-token");
});

it("serializes one rotating-token refresh across two owned processes", async () => {
  const { createServer } = await import("node:http");
  const { fork } = await import("node:child_process");
  saveAccount("youtube", {
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    account: { id: "fixture-account", name: "Fixture" },
    tokens: {
      accessToken: "expired",
      refreshToken: "single-use",
      expiresAt: 0,
    },
  });
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      );
    }, 150);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const children = [0, 1].map(() =>
    fork(path.resolve("test/fixtures/account-refresh-child.ts"), [], {
      execArgv: ["--experimental-sqlite", "--import", "tsx"],
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        CAPY_DATA_DIR: process.env.CAPY_DATA_DIR,
        CAPY_REFRESH_FIXTURE_ENDPOINT: endpoint,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }),
  );
  try {
    await Promise.all(
      children.map(
        (c) =>
          new Promise<void>((resolve, reject) => {
            c.once("message", () => resolve());
            c.once("error", reject);
            c.once("exit", (code) => {
              if (code) reject(Error(`Child exited ${code}`));
            });
          }),
      ),
    );
    const results = children.map(
      (c) =>
        new Promise<unknown>((resolve, reject) => {
          c.once("message", resolve);
          c.once("error", reject);
        }),
    );
    children.forEach((c) => c.send("start"));
    expect(await Promise.all(results)).toEqual([
      { token: "rotated-access" },
      { token: "rotated-access" },
    ]);
    expect(calls).toBe(1);
    resetAccountsCache();
    expect(loadAccounts().youtube.tokens?.refreshToken).toBe("rotated-refresh");
  } finally {
    children.forEach((c) => {
      if (c.exitCode === null) c.kill("SIGTERM");
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);

it("purges destination metrics on principal replacement but retains them on normal refresh", async () => {
  const { runtimeStore } = await import("../server/db/runtime");
  saveAccount("youtube", {
    account: { id: "pinned", name: "Pinned" },
    clientId: "client",
    clientSecret: "secret",
    tokens: { accessToken: "a", expiresAt: 9999999999999 },
  });
  runtimeStore().put("publication-metrics", "fixture", {
    accountId: "pinned",
    expiresAt: 9999999999999,
  });
  saveAccount("youtube", {
    tokens: { accessToken: "b", expiresAt: 9999999999999 },
  });
  expect(runtimeStore().get("publication-metrics", "fixture")).toBeDefined();
  saveAccount("youtube", { account: { id: "other", name: "Other" } });
  expect(runtimeStore().get("publication-metrics", "fixture")).toBeUndefined();
  expect(
    runtimeStore().get<{ generation: number }>("performance-refresh", "pinned")
      ?.value.generation,
  ).toBeGreaterThan(0);
});

it("a refresh accepted before a server error remains uncertain and is never replayed", async () => {
  saveAccount("youtube", {
    clientId: "client",
    clientSecret: "secret",
    account: { id: "fixture-account", name: "Fixture" },
    tokens: {
      accessToken: "expired",
      refreshToken: "single-use",
      expiresAt: 0,
    },
  });
  let accepted = 0;
  const endpoint = (async () => {
    accepted++;
    return Response.json({ error: "internal_error" }, { status: 500 });
  }) as typeof fetch;
  await expect(
    getAccessToken("youtube", endpoint, "fixture-account"),
  ).rejects.toThrow();
  await expect(
    getAccessToken("youtube", endpoint, "fixture-account"),
  ).rejects.toThrow(/uncertain/);
  expect(accepted).toBe(1);
});
