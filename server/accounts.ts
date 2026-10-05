import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PLATFORMS, type AccountPublic, type Platform } from "../lib/types";
import { dataDir } from "./settings";
import { OAuthError, refreshTokens, type TokenSet } from "./oauth";

/**
 * Connected social accounts in <CAPY_DATA_DIR>/accounts.json (mode 0600: it holds OAuth tokens and the
 * user's app secrets). This module is the only reader/writer; the browser only ever sees publicAccounts().
 */

export interface StoredAccount {
  clientId?: string;
  clientSecret?: string;
  tokens?: TokenSet;
  account?: { id: string; name: string; avatar?: string };
  autoPost?: boolean;
  /** TikTok only. */
  mode?: "inbox" | "direct";
  needsReconnect?: boolean;
  /** Instagram: the business account to post as, and the ones to choose from. */
  igUserId?: string;
  choices?: { id: string; name: string; avatar?: string }[];
}
export type AccountsFile = Record<Platform, StoredAccount>;

export class AuthError extends Error {}

const NAMES: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

declare global {
  // eslint-disable-next-line no-var
  var __capyAccounts: { file: string; mtime: number; data: AccountsFile } | null | undefined;
}

export function accountsFile(): string {
  return path.join(dataDir(), "accounts.json");
}

export function resetAccountsCache() {
  globalThis.__capyAccounts = null;
}

const empty = (): AccountsFile => ({ youtube: {}, instagram: {}, tiktok: {} });
const mtimeOf = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

export function loadAccounts(): AccountsFile {
  const file = accountsFile();
  const c = globalThis.__capyAccounts;
  const mtime = mtimeOf(file);
  if (c && c.file === file && c.mtime === mtime) return c.data;
  let data = empty();
  try {
    data = { ...empty(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<AccountsFile>) };
  } catch {
    /* no file yet */
  }
  globalThis.__capyAccounts = { file, mtime, data };
  return data;
}

/** Merge `patch` into one platform's record. `undefined` values are ignored; `null` deletes the key. */
export function saveAccount(p: Platform, patch: { [K in keyof StoredAccount]?: StoredAccount[K] | null }): StoredAccount {
  const all = { ...loadAccounts() };
  const next: Record<string, unknown> = { ...all[p] };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  all[p] = next as StoredAccount;
  const file = accountsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  globalThis.__capyAccounts = { file, mtime: mtimeOf(file), data: all };
  return all[p];
}

export function publicAccounts(): AccountPublic[] {
  const all = loadAccounts();
  return PLATFORMS.map((platform) => {
    const a = all[platform] ?? {};
    const connected = !!a.tokens?.accessToken && !a.needsReconnect;
    return {
      platform,
      configured: !!(a.clientId && a.clientSecret),
      connected,
      needsReconnect: a.needsReconnect || undefined,
      account: a.account,
      autoPost: a.autoPost ?? true,
      mode: platform === "tiktok" ? (a.mode ?? "inbox") : undefined,
      clientId: a.clientId,
      clientSecret: a.clientSecret ? `••••${a.clientSecret.slice(-4)}` : undefined,
      choices: platform === "instagram" ? a.choices : undefined,
      igUserId: platform === "instagram" ? a.igUserId : undefined,
    };
  });
}

/**
 * How long before expiry a token gets refreshed: Meta's 60-day tokens a week ahead; Google and TikTok 30 minutes,
 * so an upload plus a long processing wait never runs past the token.
 */
const refreshAhead = (p: Platform) => (p === "instagram" ? 7 * 86_400_000 : 30 * 60_000);

/** A usable access token, refreshed when it's about to expire. Auth failures flag the account for reconnect. */
export async function getAccessToken(p: Platform, f: typeof fetch = fetch): Promise<string> {
  const a = loadAccounts()[p];
  if (!a?.tokens?.accessToken || a.needsReconnect) throw new AuthError(`Connect ${NAMES[p]} in Settings → Accounts`);
  if (a.tokens.expiresAt - Date.now() > refreshAhead(p)) return a.tokens.accessToken;
  if (!a.clientId || !a.clientSecret) throw new AuthError(`Add your ${NAMES[p]} app's client ID and secret in Settings → Accounts`);
  try {
    const tokens = await refreshTokens(p, a.tokens, { clientId: a.clientId, clientSecret: a.clientSecret }, f);
    saveAccount(p, { tokens });
    return tokens.accessToken;
  } catch (e) {
    // the current token still works (a hiccup while renewing early): keep using it; try again next time
    if (a.tokens.expiresAt > Date.now() + 60_000) return a.tokens.accessToken;
    if (e instanceof OAuthError && e.isAuth) {
      saveAccount(p, { needsReconnect: true });
      throw new AuthError(`Reconnect ${NAMES[p]} in Settings → Accounts (${e.message})`);
    }
    throw e;
  }
}
