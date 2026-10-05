import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeUrl, exchangeCode, OAuthError, pkce, redirectUri } from "../server/oauth";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** fetch stub: records calls, answers with queued responses. */
function stub(...answers: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answers.shift() ?? new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("pkce", () => {
  it("makes a URL-safe verifier and matching S256 challenges", () => {
    const p = pkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    const sha = createHash("sha256").update(p.verifier).digest();
    expect(p.challenge).toBe(b64url(sha));
    expect(p.challengeHex).toBe(sha.toString("hex"));
  });
});

describe("authorizeUrl", () => {
  const base = { clientId: "CID", state: "ST", challenge: "CH", challengeHex: "abcd" };
  it("youtube: offline consent with PKCE on the 127.0.0.1 loopback", () => {
    const u = authorizeUrl("youtube", base);
    expect(u).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(u).toContain("access_type=offline");
    expect(u).toContain("prompt=consent");
    expect(u).toContain("code_challenge_method=S256");
    expect(u).toContain(encodeURIComponent("https://www.googleapis.com/auth/youtube.upload"));
    expect(u).toContain("redirect_uri=" + encodeURIComponent("http://127.0.0.1:53682/callback"));
  });
  it("instagram: Facebook Login for Business with publish scope", () => {
    const u = authorizeUrl("instagram", base);
    expect(u).toContain("facebook.com/v24.0/dialog/oauth");
    expect(u).toContain("instagram_content_publish");
    expect(u).toContain("redirect_uri=" + encodeURIComponent("http://localhost:53682/callback"));
  });
  it("tiktok: client_key, video.upload, no video.publish unless direct", () => {
    const u = authorizeUrl("tiktok", base);
    expect(u).toContain("tiktok.com/v2/auth/authorize");
    expect(u).toContain("client_key=CID");
    expect(u).toContain("video.upload");
    expect(u).not.toContain("video.publish");
    expect(authorizeUrl("tiktok", { ...base, tiktokDirect: true })).toContain("video.publish");
  });
  it("redirectUri per platform", () => {
    expect(redirectUri("youtube")).toBe("http://127.0.0.1:53682/callback");
    expect(redirectUri("tiktok")).toBe("http://localhost:53682/callback");
  });
});

describe("exchangeCode", () => {
  it("youtube posts the code + verifier and maps expires_in", async () => {
    const { f, calls } = stub(new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })));
    const t0 = Date.now();
    const t = await exchangeCode("youtube", "CODE", "VER", { clientId: "CID", clientSecret: "SEC" }, f);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const body = String(calls[0]!.init!.body);
    expect(body).toContain("code=CODE");
    expect(body).toContain("code_verifier=VER");
    expect(body).toContain("grant_type=authorization_code");
    expect(t.accessToken).toBe("AT");
    expect(t.refreshToken).toBe("RT");
    expect(t.expiresAt).toBeGreaterThanOrEqual(t0 + 3600_000 - 1000);
  });
  it("marks invalid_grant as an auth error", async () => {
    const { f } = stub(new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), { status: 400 }));
    const err = await exchangeCode("youtube", "C", "V", { clientId: "a", clientSecret: "b" }, f).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.isAuth).toBe(true);
  });
});

import { listenOnce } from "../server/oauth";
describe("listenOnce", () => {
  it("ignores wrong state, hands the code over for the right one, then closes", async () => {
    let got = "";
    const done = listenOnce({ state: "ST", timeoutMs: 5000, onCode: async (c) => void (got = c) });
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch("http://127.0.0.1:53682/callback?state=WRONG&code=X")).status).toBe(404);
    const ok = await fetch("http://127.0.0.1:53682/callback?state=ST&code=THE_CODE");
    expect(await ok.text()).toContain("Connected");
    await done;
    expect(got).toBe("THE_CODE");
    await expect(fetch("http://127.0.0.1:53682/callback?state=ST&code=again")).rejects.toThrow();
  });
  it("rejects when the provider sends an error", async () => {
    const done = listenOnce({ state: "S2", timeoutMs: 5000, onCode: async () => {} }).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 50));
    await fetch("http://127.0.0.1:53682/callback?state=S2&error=access_denied");
    expect(String(await done)).toContain("access_denied");
  });
});
