import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountsFile, AuthError, getAccessToken, loadAccounts, publicAccounts, resetAccountsCache, saveAccount } from "../server/accounts";

let root: string;
let n = 0;
beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-accounts-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++n));
  resetAccountsCache();
});

const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("accounts store", () => {
  it("writes 0600 and never exposes tokens or the full secret", () => {
    saveAccount("youtube", { clientId: "cid", clientSecret: "supersecret1234", tokens: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600_000 } });
    expect(statSync(accountsFile()).mode & 0o777).toBe(0o600);
    const yt = publicAccounts().find((a) => a.platform === "youtube")!;
    expect(yt.configured).toBe(true);
    expect(yt.connected).toBe(true);
    expect(yt.clientSecret).toBe("••••1234");
    expect(JSON.stringify(publicAccounts())).not.toContain("AT");
    expect(JSON.stringify(publicAccounts())).not.toContain("RT");
  });
  it("lists every platform, unconfigured ones too", () => {
    expect(publicAccounts().map((a) => a.platform)).toEqual(["youtube", "instagram", "tiktok"]);
    expect(publicAccounts()[1]!.connected).toBe(false);
  });
});

describe("getAccessToken", () => {
  const creds = { clientId: "cid", clientSecret: "sec" };
  it("returns the stored token when it is not about to expire", async () => {
    saveAccount("youtube", { ...creds, tokens: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600_000 } });
    expect(await getAccessToken("youtube", reply({}, 500))).toBe("AT");
  });
  it("refreshes inside 5 minutes and saves the new token", async () => {
    saveAccount("youtube", { ...creds, tokens: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() + 60_000 } });
    expect(await getAccessToken("youtube", reply({ access_token: "NEW", expires_in: 3600 }))).toBe("NEW");
    resetAccountsCache();
    expect(loadAccounts().youtube.tokens!.accessToken).toBe("NEW");
    expect(loadAccounts().youtube.tokens!.refreshToken).toBe("RT"); // Google omits it on refresh: keep the old one
  });
  it("flags needsReconnect on invalid_grant", async () => {
    saveAccount("youtube", { ...creds, tokens: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 1 } });
    await expect(getAccessToken("youtube", reply({ error: "invalid_grant" }, 400))).rejects.toBeInstanceOf(AuthError);
    expect(loadAccounts().youtube.needsReconnect).toBe(true);
    expect(publicAccounts()[0]!.connected).toBe(false);
  });
  it("throws AuthError when not connected", async () => {
    await expect(getAccessToken("tiktok", reply({}))).rejects.toBeInstanceOf(AuthError);
  });
});
