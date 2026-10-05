import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { Platform } from "../lib/types";

/**
 * OAuth for the user's own developer apps: authorize URLs, code exchange, refresh, and a one-shot
 * loopback listener for the redirect. No capy server is involved; tokens go straight to accounts.json.
 */

export const CALLBACK_PORT = 53682;
export const GRAPH = "v24.0";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms. */
  expiresAt: number;
  scope?: string;
}
export interface Creds {
  clientId: string;
  clientSecret: string;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** The grant or token is bad: the user has to connect again. */
    public isAuth: boolean,
  ) {
    super(message);
  }
}

/** Google prefers the IP loopback; Meta and TikTok register "localhost". */
export function redirectUri(p: Platform): string {
  return `http://${p === "youtube" ? "127.0.0.1" : "localhost"}:${CALLBACK_PORT}/callback`;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkce(): { verifier: string; challenge: string; challengeHex: string } {
  const verifier = b64url(randomBytes(48));
  const sha = createHash("sha256").update(verifier).digest();
  // TikTok's desktop flow wants the hex digest; Google uses base64url (RFC 7636)
  return { verifier, challenge: b64url(sha), challengeHex: sha.toString("hex") };
}

export const SCOPES: Record<Platform, string[]> = {
  youtube: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
  instagram: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"],
  tiktok: ["user.info.basic", "video.upload"],
};

export function authorizeUrl(p: Platform, o: { clientId: string; state: string; challenge: string; challengeHex: string; tiktokDirect?: boolean }): string {
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  if (p === "youtube") {
    return `https://accounts.google.com/o/oauth2/v2/auth?${q({
      client_id: o.clientId,
      redirect_uri: redirectUri(p),
      response_type: "code",
      scope: SCOPES.youtube.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: o.state,
      code_challenge: o.challenge,
      code_challenge_method: "S256",
    })}`;
  }
  if (p === "instagram") {
    return `https://www.facebook.com/${GRAPH}/dialog/oauth?${q({
      client_id: o.clientId,
      redirect_uri: redirectUri(p),
      response_type: "code",
      scope: SCOPES.instagram.join(","),
      state: o.state,
    })}`;
  }
  return `https://www.tiktok.com/v2/auth/authorize/?${q({
    client_key: o.clientId,
    redirect_uri: redirectUri(p),
    response_type: "code",
    scope: [...SCOPES.tiktok, ...(o.tiktokDirect ? ["video.publish"] : [])].join(","),
    state: o.state,
    code_challenge: o.challengeHex,
    code_challenge_method: "S256",
  })}`;
}

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<Json> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { error: text.slice(0, 200) || res.statusText };
  }
}

/** Throw an OAuthError for an error body or a non-2xx status. */
function check(res: Response, body: Json): Json {
  const err = body.error as string | { message?: string; code?: string } | undefined;
  if (res.ok && !err) return body;
  const msg =
    typeof err === "string" ? `${err}${body.error_description ? `: ${body.error_description}` : ""}` : (err?.message ?? (body.message as string) ?? res.statusText);
  const auth = res.status === 400 || res.status === 401 || /invalid_grant|invalid_token|expired|revoked/i.test(String(msg) + JSON.stringify(err ?? ""));
  throw new OAuthError(String(msg), auth);
}

const form = (params: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(params).toString(),
});

function toTokens(b: Json, keepRefresh?: string): TokenSet {
  const expiresIn = Number(b.expires_in ?? 3600);
  return {
    accessToken: String(b.access_token),
    refreshToken: (b.refresh_token as string | undefined) ?? keepRefresh,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: b.scope as string | undefined,
  };
}

/** Meta: swap a user token for a long-lived (~60 day) one. Also how a long-lived token is renewed. */
async function metaLongLived(token: string, c: Creds, f: typeof fetch): Promise<TokenSet> {
  const url = `https://graph.facebook.com/${GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: c.clientId, client_secret: c.clientSecret, fb_exchange_token: token })}`;
  const res = await f(url);
  const b = check(res, await readJson(res));
  return toTokens({ ...b, expires_in: b.expires_in ?? 60 * 86400 });
}

export async function exchangeCode(p: Platform, code: string, verifier: string, c: Creds, f: typeof fetch = fetch): Promise<TokenSet> {
  if (p === "youtube") {
    const res = await f("https://oauth2.googleapis.com/token", form({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri(p), grant_type: "authorization_code", code_verifier: verifier }));
    return toTokens(check(res, await readJson(res)));
  }
  if (p === "instagram") {
    const url = `https://graph.facebook.com/${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri(p), code })}`;
    const res = await f(url);
    const short = check(res, await readJson(res));
    return metaLongLived(String(short.access_token), c, f);
  }
  const res = await f("https://open.tiktokapis.com/v2/oauth/token/", form({ client_key: c.clientId, client_secret: c.clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri(p), code_verifier: verifier }));
  return toTokens(check(res, await readJson(res)));
}

export async function refreshTokens(p: Platform, t: TokenSet, c: Creds, f: typeof fetch = fetch): Promise<TokenSet> {
  if (p === "instagram") return metaLongLived(t.accessToken, c, f);
  if (!t.refreshToken) throw new OAuthError("No refresh token stored", true);
  if (p === "youtube") {
    const res = await f("https://oauth2.googleapis.com/token", form({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: t.refreshToken, grant_type: "refresh_token" }));
    return toTokens(check(res, await readJson(res)), t.refreshToken);
  }
  const res = await f("https://open.tiktokapis.com/v2/oauth/token/", form({ client_key: c.clientId, client_secret: c.clientSecret, refresh_token: t.refreshToken, grant_type: "refresh_token" }));
  return toTokens(check(res, await readJson(res)), t.refreshToken);
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>capy</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;background:#fef9f1;color:#2a1d12"><div style="text-align:center"><h1 style="font-size:22px">${title}</h1><p>${msg}</p></div>`;

/**
 * Listen once on 127.0.0.1 and ::1 for `GET /callback?code&state`. Resolves when a valid callback was
 * handled (or `onCode` failed, with that error); rejects on timeout or a busy port.
 */
export function listenOnce(o: { state: string; timeoutMs?: number; signal?: AbortSignal; onCode: (code: string) => Promise<void> }): Promise<void> {
  return new Promise((resolve, reject) => {
    const servers: http.Server[] = [];
    let done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of servers) s.close();
      if (err) reject(err);
      else resolve();
    };
    const handler: http.RequestListener = async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== o.state) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (error || !code) {
        res.end(page("Couldn't connect", error ?? "No code came back."));
        finish(new OAuthError(error ?? "No code came back", true));
        return;
      }
      try {
        await o.onCode(code);
        res.end(page("Connected", "You can close this tab and go back to capy."));
        finish();
      } catch (e) {
        res.end(page("Couldn't connect", e instanceof Error ? e.message : String(e)));
        finish(e);
      }
    };
    const timer = setTimeout(() => finish(new Error("Sign-in timed out. Click Connect to try again.")), o.timeoutMs ?? 300_000);
    o.signal?.addEventListener("abort", () => finish(new Error("Sign-in cancelled")));
    for (const host of ["127.0.0.1", "::1"]) {
      const s = http.createServer(handler);
      s.on("error", (e: NodeJS.ErrnoException) => {
        if (host === "::1" && (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT")) return; // no IPv6 loopback
        finish(e.code === "EADDRINUSE" ? new Error(`Port ${CALLBACK_PORT} is busy. Close the other app using it (or a sign-in already in progress) and try again.`) : e);
      });
      s.listen(CALLBACK_PORT, host);
      servers.push(s);
    }
  });
}
