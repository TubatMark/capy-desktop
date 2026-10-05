import { randomBytes } from "node:crypto";
import { audienceTz } from "../lib/post-time";
import type { Platform } from "../lib/types";
import { loadAccounts, saveAccount } from "./accounts";
import { authorizeUrl, exchangeCode, listenOnce, pkce, redirectUri } from "./oauth";
import { instagramAccounts } from "./platforms/instagram";
import { tiktokAccount } from "./platforms/tiktok";
import { youtubeAccount } from "./platforms/youtube";
import { queue, reconnected } from "./queue";
import { effective } from "./settings";

/**
 * Connecting an account: build the authorize URL, wait for the redirect on the loopback listener (or a URL the
 * user pastes back), exchange the code, look up who signed in, and put posts that waited on it back on schedule.
 */

interface Pending {
  state: string;
  verifier: string;
  abort: AbortController;
}
declare global {
  // eslint-disable-next-line no-var
  var __capyConnect: Map<Platform, Pending> | undefined;
}
const pending = () => (globalThis.__capyConnect ??= new Map());

/** The sign-in waiting for this platform, if any (tests, and the paste-back path). */
export const pendingConnect = (p: Platform): Pending | undefined => pending().get(p);

const NAMES: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startConnect(p: Platform, o: { listen?: boolean } = {}): Promise<{ url: string; redirectUri: string }> {
  const a = loadAccounts()[p];
  if (!a.clientId || !a.clientSecret) throw new Error(`Add your ${NAMES[p]} app's client ID and client secret first`);
  // every platform shares the loopback port: a new sign-in replaces any abandoned one
  for (const [q, old] of pending()) {
    old.abort.abort();
    pending().delete(q);
  }
  const { verifier, challenge, challengeHex } = pkce();
  const state = randomBytes(16).toString("hex");
  const abort = new AbortController();
  pending().set(p, { state, verifier, abort });
  const url = authorizeUrl(p, { clientId: a.clientId, state, challenge, challengeHex, tiktokDirect: a.mode === "direct" });
  if (o.listen !== false) {
    void listenOnce({ state, signal: abort.signal, onCode: (code) => complete(p, state, code) }).catch((e) => {
      if (!/cancelled/.test(String(e))) console.error(`[connect] ${p}:`, e instanceof Error ? e.message : e);
    });
  }
  return { url, redirectUri: redirectUri(p) };
}

/** The browser didn't reach the loopback (or the provider refused it): finish from the address the user pasted. */
export async function finishConnect(p: Platform, pastedUrl: string, f: typeof fetch = fetch) {
  let u: URL;
  try {
    u = new URL(pastedUrl.trim());
  } catch {
    throw new Error("That doesn't look like the address from your browser");
  }
  const err = u.searchParams.get("error_description") ?? u.searchParams.get("error");
  if (err) throw new Error(err);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code || !state) throw new Error("The address has no sign-in code in it. Copy the whole address from the page you landed on.");
  const pend = pending().get(p);
  await complete(p, state, code, f);
  pend?.abort.abort(); // stop the loopback listener that was still waiting
}

async function complete(p: Platform, state: string, code: string, f: typeof fetch = fetch) {
  const pend = pending().get(p);
  if (!pend || pend.state !== state) throw new Error("This sign-in expired. Click Connect again.");
  pending().delete(p);
  const a = loadAccounts()[p];
  const tokens = await exchangeCode(p, code, pend.verifier, { clientId: a.clientId!, clientSecret: a.clientSecret! }, f);
  const ctx = { token: tokens.accessToken, fetch: f, sleep, log: () => {} };
  if (p === "youtube") {
    saveAccount(p, { tokens, account: await youtubeAccount(ctx), needsReconnect: null });
  } else if (p === "tiktok") {
    saveAccount(p, { tokens, account: await tiktokAccount(ctx), needsReconnect: null });
  } else {
    const choices = await instagramAccounts(ctx);
    if (!choices.length) throw new Error("No Instagram professional account is linked to your Facebook Pages. Link one in the Instagram app (Settings → Account type), then connect again.");
    const keep = choices.find((c) => c.id === a.igUserId) ?? (choices.length === 1 ? choices[0] : undefined);
    saveAccount(p, { tokens, choices, igUserId: keep?.id ?? null, account: keep ?? { id: "", name: "Pick an account" }, needsReconnect: null });
  }
  queue().mutate((e) => reconnected(e, p, audienceTz(effective().postingAudience), new Date()));
}
