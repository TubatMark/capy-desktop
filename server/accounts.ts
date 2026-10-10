import { purgePublicationMetrics } from "./performance";
import { capabilitiesForAccount } from "./platform-capabilities";
import { createHash, randomUUID } from "node:crypto";
import { fence } from "./worker/context";
import {
  chmodSync,
  openSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PLATFORMS, type AccountPublic, type Platform } from "../lib/types";
import { runtimeStore } from "./db/runtime";
import { dataDir } from "./settings";
import { OAuthError, refreshTokens, type TokenSet } from "./oauth";

/**
 * Connected social accounts in <CAPY_DATA_DIR>/accounts.json (mode 0600: it holds OAuth tokens and the
 * user's app secrets). This module is the only reader/writer; the browser only ever sees publicAccounts().
 */

export interface StoredAccount {
  connectedAt?: number;
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

const NAMES: Record<Platform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

declare global {
  // eslint-disable-next-line no-var
  var __capyAccounts:
    { file: string; mtime: number; data: AccountsFile } | null | undefined;
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
    data = {
      ...empty(),
      ...(JSON.parse(readFileSync(file, "utf8")) as Partial<AccountsFile>),
    };
  } catch {
    /* no file yet */
  }
  globalThis.__capyAccounts = { file, mtime, data };
  return data;
}

/** Merge `patch` into one platform's record. `undefined` values are ignored; `null` deletes the key. */
export function saveAccount(
  p: Platform,
  patch: { [K in keyof StoredAccount]?: StoredAccount[K] | null },
): StoredAccount {
  return fence(() =>
    runtimeStore().transaction(() => {
      resetAccountsCache();
      const all = { ...loadAccounts() };
      const previous = all[p];
      const next: Record<string, unknown> = { ...all[p] };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      all[p] = next as StoredAccount;
      const previousId =
        p === "instagram" ? previous.igUserId : previous.account?.id;
      const nextId = p === "instagram" ? all[p].igUserId : all[p].account?.id;
      if (
        previousId &&
        (previousId !== nextId ||
          previous.clientId !== all[p].clientId ||
          previous.clientSecret !== all[p].clientSecret ||
          !all[p].tokens?.accessToken ||
          all[p].needsReconnect)
      )
        purgePublicationMetrics(previousId);
      const file = accountsFile();
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      const fd = openSync(tmp, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
      const parent = openSync(path.dirname(file), "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      globalThis.__capyAccounts = { file, mtime: mtimeOf(file), data: all };
      return all[p];
    }),
  );
}

export function publicAccounts(): AccountPublic[] {
  const all = loadAccounts();
  return PLATFORMS.map((platform) => {
    const a = all[platform] ?? {};
    const connected = !!a.tokens?.accessToken && !a.needsReconnect;
    return {
      platform,
      capabilities: capabilitiesForAccount(platform, a),
      role: "publishing",
      connectedAt: a.connectedAt,
      configured: !!(a.clientId && a.clientSecret),
      connected,
      needsReconnect: a.needsReconnect || undefined,
      account: a.account,
      autoPost: a.autoPost ?? true,
      mode: platform === "tiktok" ? (a.mode ?? "inbox") : undefined,
      clientId: a.clientId,
      clientSecret: a.clientSecret
        ? `••••${a.clientSecret.slice(-4)}`
        : undefined,
      choices: platform === "instagram" ? a.choices : undefined,
      igUserId: platform === "instagram" ? a.igUserId : undefined,
    };
  });
}

/**
 * How long before expiry a token gets refreshed: Meta's 60-day tokens a week ahead; Google and TikTok 30 minutes,
 * so an upload plus a long processing wait never runs past the token.
 */
const refreshAhead = (p: Platform) =>
  p === "instagram" ? 7 * 86_400_000 : 30 * 60_000;

/** A usable access token, refreshed when it's about to expire. Auth failures flag the account for reconnect. */
const refreshFlights = new Map<string, Promise<string>>();
const principal = (p: Platform, a: StoredAccount) =>
  p === "instagram" ? a.igUserId : a.account?.id;
const credentialHash = (a: StoredAccount) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        a.account?.id,
        a.igUserId,
        a.clientId,
        a.clientSecret,
        a.tokens,
      ]),
    )
    .digest("hex");
const freshAccounts = () => {
  resetAccountsCache();
  return loadAccounts();
};
/** Exact-principal refresh, single-flight across callers and leased across app processes. */
export async function getAccessToken(
  p: Platform,
  f: typeof fetch = fetch,
  expectedAccountId?: string,
): Promise<string> {
  const a = freshAccounts()[p];
  if (
    !a.tokens?.accessToken ||
    a.needsReconnect ||
    (expectedAccountId !== undefined && principal(p, a) !== expectedAccountId)
  )
    throw new AuthError(`Connect the selected ${NAMES[p]} publishing account`);
  if (a.tokens.expiresAt - Date.now() > refreshAhead(p))
    return a.tokens.accessToken;
  if (!a.clientId || !a.clientSecret)
    throw new AuthError(`Configure ${NAMES[p]} client credentials`);
  const epoch = credentialHash(a),
    key = `${accountsFile()}:${p}:${epoch}`;
  const existing = refreshFlights.get(key);
  if (existing) return existing;
  const promise = refreshExact(p, a, epoch, f);
  refreshFlights.set(key, promise);
  try {
    return await promise;
  } finally {
    if (refreshFlights.get(key) === promise) refreshFlights.delete(key);
  }
}
async function refreshExact(
  p: Platform,
  a: StoredAccount,
  epoch: string,
  f: typeof fetch,
): Promise<string> {
  const store = runtimeStore(),
    lockKey = `${p}:${principal(p, a) ?? ""}`,
    owner = randomUUID(),
    started = Date.now();
  type Lease = {
    owner: string;
    epoch: string;
    expiresAt: number;
    state: "pending" | "done" | "uncertain";
  };
  const unchanged = () => {
    const now = freshAccounts()[p];
    if (credentialHash(now) !== epoch)
      throw new AuthError(
        "Publishing account or credentials changed during refresh",
      );
    return now;
  };
  while (true) {
    const current = freshAccounts()[p];
    if (credentialHash(current) !== epoch) {
      if (
        principal(p, current) !== principal(p, a) ||
        current.clientId !== a.clientId ||
        current.clientSecret !== a.clientSecret
      )
        throw new AuthError("Publishing account changed during refresh");
      return getAccessToken(p, f, principal(p, a));
    }
    const claim = fence(() =>
      store.transaction(() => {
        const lease = store.get<Lease>("account-refresh", lockKey)?.value;
        if (lease && lease.epoch === epoch && lease.state !== "done") {
          if (lease.state === "uncertain" || lease.expiresAt <= Date.now())
            throw new AuthError(
              "A prior token refresh has an uncertain outcome; reconnect this publishing account",
            );
          return false;
        }
        store.put("account-refresh", lockKey, {
          owner,
          epoch,
          expiresAt: Date.now() + 45000,
          state: "pending",
        });
        return true;
      }),
    );
    if (claim) break;
    if (Date.now() - started > 35000)
      throw new Error("Publishing token refresh is still in progress");
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const bounded = (async (input, init) =>
      f(input, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(30000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      })) as typeof fetch;
    const tokens = await refreshTokens(
      p,
      a.tokens!,
      { clientId: a.clientId!, clientSecret: a.clientSecret! },
      bounded,
    );
    return fence(() =>
      store.transaction(() => {
        unchanged();
        const lease = store.get<Lease>("account-refresh", lockKey)?.value;
        if (
          lease?.owner !== owner ||
          lease.epoch !== epoch ||
          lease.state !== "pending" ||
          lease.expiresAt <= Date.now()
        )
          throw new AuthError(
            "Publishing refresh ownership expired; reconnect if needed",
          );
        saveAccount(p, { tokens });
        store.put("account-refresh", lockKey, { ...lease, state: "done" });
        return tokens.accessToken;
      }),
    );
  } catch (error) {
    // Never save a stale token or reconnect flag over a newly connected principal.
    unchanged();
    fence(() =>
      store.transaction(() => {
        const lease = store.get<Lease>("account-refresh", lockKey)?.value;
        if (lease?.owner === owner)
          store.put("account-refresh", lockKey, {
            ...lease,
            state: error instanceof OAuthError ? "done" : "uncertain",
          });
        if (
          error instanceof OAuthError &&
          error.isAuth &&
          a.tokens!.expiresAt <= Date.now() + 60000
        )
          saveAccount(p, { needsReconnect: true });
      }),
    );
    if (a.tokens!.expiresAt > Date.now() + 60000) return a.tokens!.accessToken;
    if (error instanceof OAuthError && error.isAuth)
      throw new AuthError(`Reconnect ${NAMES[p]} to restore publishing access`);
    throw error;
  }
}

/** Reading consent is a separate principal; never reuse a posting token implicitly. */
export function readingAccountsFile(): string {
  return path.join(dataDir(), "youtube-reading.json");
}
export function loadReadingAccount(): StoredAccount {
  try {
    return JSON.parse(
      readFileSync(readingAccountsFile(), "utf8"),
    ) as StoredAccount;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
export function saveReadingAccount(patch: {
  [K in keyof StoredAccount]?: StoredAccount[K] | null;
}): StoredAccount {
  return fence(() => {
    const next = { ...loadReadingAccount() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete (next as Record<string, unknown>)[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    const file = readingAccountsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    runtimeStore().mutate(
      "account-roles",
      "youtube:reading",
      () => ({}),
      () => ({
        role: "reading",
        platform: "youtube",
        accountId: next.account?.id,
        needsReconnect: !!next.needsReconnect,
      }),
    );
    return next;
  });
}
export function publicReadingAccount(): AccountPublic {
  const a = loadReadingAccount();
  return {
    platform: "youtube",
    role: "reading",
    connectedAt: a.connectedAt,
    configured: !!(a.clientId && a.clientSecret),
    connected: !!a.tokens?.accessToken && !a.needsReconnect,
    needsReconnect: a.needsReconnect || undefined,
    account: a.account,
    autoPost: false,
    clientId: a.clientId,
    clientSecret: a.clientSecret
      ? `••••${a.clientSecret.slice(-4)}`
      : undefined,
  };
}
/** Refresh only this reading principal, guarding against a reconnect during the request. */
export async function getReadingAccessToken(
  accountId: string,
  f: typeof fetch = fetch,
): Promise<string> {
  const a = loadReadingAccount();
  if (
    !a.tokens?.accessToken ||
    a.needsReconnect ||
    !accountId ||
    a.account?.id !== accountId
  )
    throw new AuthError(
      "Connect the YouTube reading account in Settings → Accounts",
    );
  if (
    !a.tokens.scope
      ?.split(/\s+/)
      .includes("https://www.googleapis.com/auth/youtube.readonly")
  ) {
    saveReadingAccount({ needsReconnect: true });
    throw new AuthError(
      "Reconnect the YouTube reading account to grant subscription access",
    );
  }
  if (a.tokens.expiresAt - Date.now() > refreshAhead("youtube"))
    return a.tokens.accessToken;
  if (!a.clientId || !a.clientSecret)
    throw new AuthError("Configure the YouTube reading account first");
  try {
    const tokens = await refreshTokens(
      "youtube",
      a.tokens,
      { clientId: a.clientId, clientSecret: a.clientSecret },
      f,
    );
    if (loadReadingAccount().tokens?.accessToken !== a.tokens.accessToken)
      throw new AuthError("The reading account changed; refresh subscriptions");
    saveReadingAccount({ tokens });
    return tokens.accessToken;
  } catch (e) {
    if (e instanceof OAuthError && e.isAuth) {
      if (loadReadingAccount().tokens?.accessToken === a.tokens.accessToken)
        saveReadingAccount({ needsReconnect: true });
      throw new AuthError(
        "Reconnect the YouTube reading account to restore subscription access",
      );
    }
    throw e;
  }
}
