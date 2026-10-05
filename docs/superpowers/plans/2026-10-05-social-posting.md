# Social Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post rendered clips to YouTube Shorts, Instagram Reels and TikTok through each platform's free official API with the user's own developer apps. Every rendered clip lands in a review list. Approved clips get staggered slots (at most 2 a day per platform, at least 4 h apart). A background poster posts them, and capy stays in the menu bar while posts are queued.

**Architecture:**
- **Pure logic, tested directly:** slot allocation (`lib/post-time.ts`), post-text builders (`server/platforms/text.ts`), queue transitions (`server/queue.ts` pure functions), PKCE and authorize URLs (`server/oauth.ts`).
- **Platform clients:** one file per platform under `server/platforms/`. Each takes an injectable `fetch`, so it can be tested against a stub.
- **Stores:** `server/accounts.ts` (`accounts.json`, 0600) and `server/queue.ts` (`queue.json`) follow the `server/settings.ts` pattern: atomic writes, `globalThis` state.
- **Background loop:** `server/poster.ts` ticks every 30 s and is started from `instrumentation.ts`.
- **UI:** Settings → Accounts, a `/queue` page, and Approve/Reject on the clip page.
- **Electron:** `electron/tray.ts` adds the menu-bar icon and keeps the app alive while posts are queued.

**Tech Stack:** TypeScript, Next.js 16 route handlers and `instrumentation.ts`, Node `http` loopback server, `fetch`/`FormData`/`openAsBlob`, vitest, Electron `Tray` and `powerMonitor`.

**Spec:** `docs/superpowers/specs/2026-10-05-social-posting-design.md`

## Global Constraints

- **No paid services.** Official APIs only:
  - YouTube Data API v3
  - Instagram Graph API with Facebook Login for Business (`graph.facebook.com` and `rupload.facebook.com`, version constant `GRAPH = "v24.0"`)
  - TikTok Content Posting API v2
- **Loopback callback port 53682, path `/callback`.** Google uses `http://127.0.0.1:53682/callback`. Meta and TikTok use `http://localhost:53682/callback`. The listener binds both `127.0.0.1` and `::1`, and closes after the callback or 5 minutes.
- **Files:** `<dataDir>/accounts.json` (mode 0600) and `<dataDir>/queue.json`, where `dataDir()` comes from `server/settings.ts`.
- **Queue entry key** is `${jobId}:${n}:${platform}`. Statuses: `review | scheduled | posting | posted | needs_action | failed | rejected`.
- **Slots:** at most 2 per platform per audience-local day, at least 4 h apart, at least 30 minutes from now. One shared `slotAt` across a clip's platforms.
- **Missed slots:** under 2 h late, post now. Later than that, reschedule to the next free slot and add a history note.
- **Retries** at 2, 10 and 30 minutes, then `failed`. Auth errors (401/403/`invalid_grant`) give `needs_action` plus `needsReconnect`.
- **Text limits:** YouTube title ≤ 100 characters and tags ≤ 500 characters in total. Instagram caption ≤ 2,200 characters with ≤ 30 hashtags. TikTok caption ≤ 2,200 characters.
- **Nothing posts without approval.** Render only creates `review` entries.
- **Copy:** UI text says "AI", not "Claude". The posting guide is written for the user's own developer apps.
- **I can't create developer accounts or enter the user's credentials.** The connect flows are verified by the user with their own apps (Task 11).

## Review Focus

1. **Re-render while an entry is `posting`.** The upload is reading the mp4 while ffmpeg rewrites it. Expect render completion to leave a `posting` entry alone; the poster uploads whatever file existed when it started. Test in Task 5.
2. **Clock or DST edges.** A slot that falls in a non-existent local hour (spring forward) must not crash or double-book. Expect `allocateSlot` to skip candidates whose local hour doesn't round-trip. Test in Task 1.
3. **A clip or job deleted after approval.** The poster finds no file. Expect `needs_action: "Clip file missing, re-render it"`, never a crash loop. Test in Task 6.
4. **Two ticks overlapping** (a slow upload taking longer than 30 s). Expect one post at a time per platform, and an entry already `posting` is never picked again. Test in Task 6.
5. **The app quit mid-upload.** On load, an entry stuck in `posting` goes back to `scheduled` with `slotAt = now` (it posts on the next tick) and the history note "Interrupted, retrying". Test in Task 5.

---

### Task 1: Slot allocator

**Files:**
- Modify: `lib/post-time.ts`
- Test: `test/post-time.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export type Platform = "youtube" | "instagram" | "tiktok"` (in `lib/types.ts`)
  - `allocateSlot(taken: { platform: Platform; at: number }[], platforms: Platform[], audienceTz: string, now?: Date, horizonDays?: number): Date | null`
  - `CANDIDATE_HOURS: Record<number, number[]>`
  - `fmtIn(d: Date, tz: string): string` (exported `fmt`)

- [ ] **Step 1: Add the type.** Add `export type Platform = "youtube" | "instagram" | "tiktok"; export const PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];` to `lib/types.ts`.
- [ ] **Step 2: Write the failing tests** (append to `test/post-time.test.ts`):

```ts
import { allocateSlot } from "../lib/post-time";

describe("allocateSlot", () => {
  const tz = "America/New_York";
  const now = new Date("2026-09-23T10:00:00Z"); // Wed 6:00 ET
  const hourET = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d)) % 24;

  it("gives the earliest candidate today when nothing is taken", () => {
    const d = allocateSlot([], ["youtube"], tz, now)!;
    expect(d.getTime()).toBeGreaterThan(now.getTime() + 30 * 60_000);
    expect(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d)).toBe("Wed");
  });
  it("puts at most 2 per platform per local day, 4h apart, and spreads 6 clips over 3 days", () => {
    const taken: { platform: "youtube"; at: number }[] = [];
    for (let i = 0; i < 6; i++) taken.push({ platform: "youtube", at: allocateSlot(taken, ["youtube"], tz, now)!.getTime() });
    const days = new Map<string, number[]>();
    for (const t of taken) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t.at));
      days.set(day, [...(days.get(day) ?? []), t.at]);
    }
    expect(days.size).toBe(3);
    for (const ts of days.values()) {
      expect(ts.length).toBe(2);
      expect(Math.abs(ts[1]! - ts[0]!)).toBeGreaterThanOrEqual(4 * 3600_000);
    }
  });
  it("needs every chosen platform free at the shared time", () => {
    const first = allocateSlot([], ["youtube", "tiktok"], tz, now)!;
    const second = allocateSlot([{ platform: "tiktok", at: first.getTime() }], ["youtube", "tiktok"], tz, now)!;
    expect(second.getTime() - first.getTime()).toBeGreaterThanOrEqual(4 * 3600_000);
    // youtube alone can still take the earlier time
    expect(allocateSlot([{ platform: "tiktok", at: first.getTime() }], ["youtube"], tz, now)!.getTime()).toBe(first.getTime());
  });
  it("only uses candidate hours in the audience zone", () => {
    const d = allocateSlot([], ["instagram"], tz, now)!;
    expect([11, 12, 15, 16, 17, 19, 20]).toContain(hourET(d));
  });
  it("returns null when the horizon is full", () => {
    const taken: { platform: "youtube"; at: number }[] = [];
    let d: Date | null;
    while ((d = allocateSlot(taken, ["youtube"], tz, now, 2))) taken.push({ platform: "youtube", at: d.getTime() });
    expect(taken.length).toBeLessThanOrEqual(4);
  });
  it("survives the DST change without duplicate slots", () => {
    const spring = new Date("2027-03-13T12:00:00Z"); // day before US spring-forward
    const taken: { platform: "youtube"; at: number }[] = [];
    for (let i = 0; i < 6; i++) taken.push({ platform: "youtube", at: allocateSlot(taken, ["youtube"], tz, spring)!.getTime() });
    expect(new Set(taken.map((t) => t.at)).size).toBe(6);
  });
});
```

- [ ] **Step 3: Run it.** `pnpm vitest run test/post-time.test.ts`. Expected: FAIL (`allocateSlot` not exported).
- [ ] **Step 4: Implement** in `lib/post-time.ts`:

```ts
/** Candidate posting hours per weekday (audience local), best first; every day has two at least 4h apart. */
export const CANDIDATE_HOURS: Record<number, number[]> = {
  5: [17, 15, 19, 12], 4: [17, 15, 19, 12], 6: [16, 11, 19, 20], 3: [16, 12, 20, 15],
  0: [12, 16, 19, 20], 2: [15, 11, 19, 18], 1: [15, 11, 19, 18],
};
const DAY_MS = 86_400_000, GAP_MS = 4 * 3_600_000, PER_DAY = 2;

/**
 * Earliest good slot (≥30 min away) where every platform has <2 posts that audience-local day and none
 * within 4h. Candidates are tried in time order. `taken` holds scheduled/posting/recently posted entries.
 */
export function allocateSlot(taken: { platform: Platform; at: number }[], platforms: Platform[], audienceTz: string, now = new Date(), horizonDays = 14): Date | null {
  const dayKey = (t: number) => { const p = partsIn(new Date(t), audienceTz); return `${p.y}-${p.m}-${p.d}`; };
  const start = partsIn(now, audienceTz);
  for (let off = 0; off < horizonDays; off++) {
    const p = partsIn(new Date(Date.UTC(start.y, start.m - 1, start.d + off, 12)), audienceTz);
    const cands = (CANDIDATE_HOURS[p.wd] ?? [17])
      .map((h) => ({ h, at: fromZoned(p.y, p.m, p.d, h, audienceTz) }))
      .filter(({ h, at }) => partsIn(at, audienceTz).h === h) // skip hours that don't exist (DST)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const { at } of cands) {
      const t = at.getTime();
      if (t < now.getTime() + 30 * 60_000) continue;
      const ok = platforms.every((pl) => {
        const mine = taken.filter((x) => x.platform === pl);
        return mine.filter((x) => dayKey(x.at) === dayKey(t)).length < PER_DAY && mine.every((x) => Math.abs(x.at - t) >= GAP_MS);
      });
      if (ok) return at;
    }
  }
  return null;
}
```

  Import `type Platform` from `./types`. Export `fmt` as `fmtIn` (keep the internal name as an alias). The `DAY_MS` constant isn't needed; leave it out if the linter complains.

- [ ] **Step 5: Run it.** `pnpm vitest run test/post-time.test.ts && pnpm typecheck`. Expected: PASS. If "spreads 6 clips over 3 days" fails because a day's candidates can't fit two 4 h apart in time order (for example Wed 12 and 15), fix `CANDIDATE_HOURS` so every day has a pair ≥ 4 h apart among its earliest options. Don't loosen the test.
- [ ] **Step 6: Commit.** `git add lib test && git commit -m "Posting: slot allocator (2/day/platform, 4h gap, shared across platforms)"`

---

### Task 2: Shared types and post-text builders

**Files:**
- Modify: `lib/types.ts`
- Create: `server/platforms/text.ts`
- Test: `test/post-text.test.ts`

**Interfaces:**
- Produces (in `lib/types.ts`):

```ts
export type QueueStatus = "review" | "scheduled" | "posting" | "posted" | "needs_action" | "failed" | "rejected";
export interface PostText { title?: string; description?: string; tags?: string[]; caption?: string }
export interface QueueEntry {
  key: string; jobId: string; n: number; platform: Platform; status: QueueStatus;
  /** Clip title and thumbnail/video media urls for the review card. */
  clipTitle: string; videoUrl?: string; thumbUrl?: string; thumbAt?: number;
  slotAt?: number; text: PostText; attempts: number; nextTryAt?: number;
  result?: { id?: string; url?: string; note?: string }; error?: string;
  history: { t: number; msg: string }[]; createdAt: number; updatedAt: number;
}
export interface AccountPublic {
  platform: Platform; configured: boolean; connected: boolean; needsReconnect?: boolean;
  account?: { id: string; name: string; avatar?: string }; autoPost: boolean;
  /** TikTok only. */ mode?: "inbox" | "direct";
  clientId?: string; /** redacted, "••••abcd" */ clientSecret?: string;
  /** Instagram: business accounts to choose from when more than one Page has one. */ choices?: { id: string; name: string }[];
}
```

  Also `JobSettings.autoPost?: boolean`, `AppSettings.postingAudience?: string`, `AppSettings.postingPaused?: boolean`.
- Produces (`server/platforms/text.ts`):
  - `youtubeText(p: Publish): PostText`
  - `instagramText(p: Publish, hook?: string): PostText`
  - `tiktokText(p: Publish): PostText`
  - `postTextFor(platform, p, hook?)`
  - where `type Publish = { ytTitle: string; description: string; hashtags: string[] }`

- [ ] **Step 1: Write the failing test** `test/post-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { instagramText, tiktokText, youtubeText } from "../server/platforms/text";

const p = { ytTitle: "Mia almost misses the flight ✈️ #travel #shorts", description: "What happens.\nWould you wait?\nCredit: Mia\n#travel #mia #shorts", hashtags: ["travel", "#mia", "shorts"] };

describe("post text", () => {
  it("youtube: title ≤100, tags without # and ≤500 chars total", () => {
    const t = youtubeText({ ...p, ytTitle: "x".repeat(140), hashtags: Array.from({ length: 80 }, (_, i) => `tag${i}`) });
    expect(t.title!.length).toBeLessThanOrEqual(100);
    expect(t.tags!.every((x) => !x.startsWith("#"))).toBe(true);
    expect(t.tags!.join(",").length).toBeLessThanOrEqual(500);
    expect(t.description).toContain("Credit: Mia");
  });
  it("instagram: hook first line, description, ≤30 hashtags, ≤2200 chars, no duplicate hashtag line", () => {
    const t = instagramText({ ...p, hashtags: Array.from({ length: 40 }, (_, i) => `h${i}`) }, "Mia almost misses it");
    expect(t.caption!.startsWith("Mia almost misses it")).toBe(true);
    expect((t.caption!.match(/#\w+/g) ?? []).length).toBeLessThanOrEqual(30);
    expect(t.caption!.length).toBeLessThanOrEqual(2200);
  });
  it("tiktok: title text plus hashtags, ≤2200", () => {
    const t = tiktokText({ ...p, description: "y".repeat(5000) });
    expect(t.caption!.length).toBeLessThanOrEqual(2200);
    expect(t.caption).toContain("#mia");
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `server/platforms/text.ts`:

```ts
import type { Platform, PostText } from "../../lib/types";

export type Publish = { ytTitle: string; description: string; hashtags: string[] };

const bare = (h: string) => h.replace(/^#/, "").replace(/\s+/g, "");
const tagsOf = (p: Publish) => [...new Set(p.hashtags.map(bare).filter(Boolean))];
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
/** The description without a trailing all-hashtags line (each platform adds its own). */
const body = (d: string) => d.split("\n").filter((l) => !/^\s*(#\S+\s*)+$/.test(l)).join("\n").trim();

export function youtubeText(p: Publish): PostText {
  const tags: string[] = [];
  for (const t of tagsOf(p)) if ([...tags, t].join(",").length <= 500) tags.push(t);
  return { title: clip(p.ytTitle.trim(), 100), description: clip(p.description.trim(), 5000), tags };
}

export function instagramText(p: Publish, hook?: string): PostText {
  const tags = tagsOf(p).slice(0, 30).map((t) => `#${t}`).join(" ");
  const head = [hook?.trim(), body(p.description)].filter(Boolean).join("\n\n");
  return { caption: clip(head, 2200 - tags.length - 2) + (tags ? `\n\n${tags}` : "") };
}

export function tiktokText(p: Publish): PostText {
  const tags = tagsOf(p).map((t) => `#${t}`).join(" ");
  const title = p.ytTitle.replace(/#\S+/g, "").trim();
  return { caption: clip(`${title}\n\n${body(p.description)}`.trim(), 2200 - tags.length - 1) + (tags ? ` ${tags}` : "") };
}

export function postTextFor(platform: Platform, p: Publish, hook?: string): PostText {
  return platform === "youtube" ? youtubeText(p) : platform === "instagram" ? instagramText(p, hook) : tiktokText(p);
}
```

- [ ] **Step 4: Run it.** `pnpm vitest run test/post-text.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add lib server/platforms/text.ts test/post-text.test.ts && git commit -m "Posting: queue/account types and per-platform post text"`

---

### Task 3: Accounts store and OAuth helpers

**Files:**
- Create: `server/accounts.ts`, `server/oauth.ts`
- Test: `test/accounts.test.ts`, `test/oauth.test.ts`

**Interfaces:**
- Produces (`server/oauth.ts`):
  - `pkce(): { verifier: string; challenge: string; challengeHex: string }`
  - `redirectUri(platform): string`
  - `authorizeUrl(platform, { clientId, state, challenge, challengeHex, tiktokDirect? }): string`
  - `exchangeCode(platform, code, verifier, creds, fetchImpl?): Promise<TokenSet>`
  - `refreshTokens(platform, tokens, creds, fetchImpl?): Promise<TokenSet>`
  - `listenOnce(o: { state: string; timeoutMs?: number; onCode(code: string): Promise<void> }): Promise<void>` (loopback, both stacks)
  - `TokenSet = { accessToken: string; refreshToken?: string; expiresAt: number; scope?: string }`
- Produces (`server/accounts.ts`):
  - `loadAccounts(): AccountsFile`
  - `saveAccount(platform, patch): void`
  - `publicAccounts(): AccountPublic[]`
  - `getAccessToken(platform, fetchImpl?): Promise<string>` (refreshes within 5 minutes of expiry, Meta under 7 days; throws `AuthError` and sets `needsReconnect` on `invalid_grant`, 400 or 401)
  - `class AuthError extends Error`
  - `accountsFile(): string`
  - `AccountsFile = Record<Platform, StoredAccount>`, where `StoredAccount = { clientId?: string; clientSecret?: string; tokens?: TokenSet; account?: {id,name,avatar?}; autoPost?: boolean; mode?: "inbox"|"direct"; needsReconnect?: boolean; igUserId?: string; choices?: {id,name}[] }`

- [ ] **Step 1: Write the failing tests.**
  - `test/oauth.test.ts` should check:
    - PKCE: the verifier is 43–128 characters from the URL-safe set, the challenge is base64url SHA-256 of the verifier, and `challengeHex` is hex SHA-256.
    - `authorizeUrl("youtube")` contains `accounts.google.com/o/oauth2/v2/auth`, `access_type=offline`, `prompt=consent`, `code_challenge_method=S256`, the `youtube.upload` scope, and `redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback`.
    - `authorizeUrl("instagram")` contains `facebook.com/v24.0/dialog/oauth` and `instagram_content_publish`.
    - `authorizeUrl("tiktok")` contains `tiktok.com/v2/auth/authorize`, `client_key=`, `video.upload`, and leaves out `video.publish` unless `tiktokDirect`.
    - `exchangeCode("youtube")` against a stub fetch posts the form to `oauth2.googleapis.com/token` with `code_verifier`, and maps `expires_in` to `expiresAt`.
  - `test/accounts.test.ts` (temp `CAPY_DATA_DIR`, as in the settings tests) should check:
    - `saveAccount` writes mode 0600.
    - `publicAccounts()` never includes tokens and redacts the secret to `••••` plus its last 4 characters.
    - `getAccessToken` returns the stored token when it's more than 5 minutes from expiry.
    - It refreshes through a stub fetch when it's inside 5 minutes, and persists the new token.
    - On `{error:"invalid_grant"}` it throws `AuthError` and sets `needsReconnect`.
- [ ] **Step 2: Run them.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `server/oauth.ts`.**
  - Constants:
    - YouTube scopes: `https://www.googleapis.com/auth/youtube.upload` and `https://www.googleapis.com/auth/youtube.readonly`
    - Instagram scopes: `instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management`
    - TikTok scopes: `user.info.basic,video.upload` (plus `,video.publish` when direct)
  - Token endpoints:
    - Google: POST form to `https://oauth2.googleapis.com/token`.
    - Meta: GET `https://graph.facebook.com/v24.0/oauth/access_token?client_id&redirect_uri&client_secret&code`, then exchange for a long-lived token with GET `…/oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token`. `expiresAt = now + expires_in` (default 60 days).
    - TikTok: POST form to `https://open.tiktokapis.com/v2/oauth/token/` with `client_key, client_secret, code, grant_type, redirect_uri, code_verifier`.
  - Refresh:
    - Google: `grant_type=refresh_token`.
    - TikTok: `grant_type=refresh_token` with `client_key`.
    - Meta: `fb_exchange_token` with the current token.
  - Errors: an error JSON or a non-2xx status throws `new OAuthError(message, isAuth)`, where `isAuth` is true for `invalid_grant`, `invalid_token`, 400 or 401.
  - `listenOnce`:
    - `http.createServer` on `127.0.0.1:53682` and `::1:53682` (ignore `EADDRNOTAVAIL` on `::1`; reject `EADDRINUSE` with "Port 53682 is busy. Close the other app using it and try again").
    - Only `GET /callback` with a matching `state` is accepted. It calls `onCode` and answers with a small HTML page saying "Connected. You can close this tab and go back to capy." or "Couldn't connect: <message>".
    - Both servers close after the first valid callback or after `timeoutMs` (default 300000).
- [ ] **Step 4: Implement `server/accounts.ts`.**
  - It's modelled on `server/settings.ts`: `globalThis.__capyAccounts` cache, `accountsFile() = path.join(dataDir(), "accounts.json")`, atomic tmp then rename, `chmod 0600`.
  - `publicAccounts()` maps every platform in `PLATFORMS` with `configured = !!(clientId && clientSecret)`, `connected = !!tokens?.accessToken && !needsReconnect`, and `autoPost` defaulting to true when connected.
  - `getAccessToken`: when the token is about to expire, call `refreshTokens` and save. On `OAuthError` with `isAuth`, save `needsReconnect: true` and throw `AuthError("Reconnect <Platform> in Settings → Accounts")`.
- [ ] **Step 5: Run it.** `pnpm vitest run test/oauth.test.ts test/accounts.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add server/oauth.ts server/accounts.ts test/oauth.test.ts test/accounts.test.ts && git commit -m "Posting: accounts store (0600) and OAuth helpers with PKCE + loopback"`

---

### Task 4: Platform clients

**Files:**
- Create: `server/platforms/youtube.ts`, `server/platforms/instagram.ts`, `server/platforms/tiktok.ts`, `server/platforms/types.ts`
- Test: `test/platforms.test.ts`

**Interfaces:**
- Produces (`server/platforms/types.ts`):

```ts
export interface PostJob { file: string; thumbFile?: string; thumbAt?: number; text: PostText; durationSec?: number }
export type PostOutcome =
  | { kind: "posted"; id: string; url?: string; note?: string }
  | { kind: "needs_action"; id?: string; url?: string; note: string };
export class PlatformError extends Error { constructor(msg: string, public retryable: boolean, public auth = false) { super(msg); } }
export interface ClientCtx { token: string; fetch: typeof fetch; sleep: (ms: number) => Promise<void>; log: (m: string) => void }
```

- Produces:
  - `postYouTube(job, ctx): Promise<PostOutcome>` and `youtubeAccount(ctx)`
  - `postInstagram(job, ctx & { igUserId: string }): Promise<PostOutcome>` and `instagramAccounts(ctx): Promise<{ id: string; name: string; avatar?: string }[]>`
  - `postTikTok(job, ctx & { mode: "inbox" | "direct" }): Promise<PostOutcome>` and `tiktokAccount(ctx)`
  - `httpError(res, body): PlatformError`, which maps 401/403 → auth, 429/5xx → retryable, other 4xx → not retryable

- [ ] **Step 1: Write the failing tests** in `test/platforms.test.ts`. Use a stub `fetch` that records calls and returns queued `Response`s, a temp 1 KB mp4, and `sleep: async () => {}`. Cases:
  1. **YouTube happy path:**
     - POST to `upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with body `snippet.title` and `status.privacyStatus === "public"` returns a `Location` header.
     - PUT to that location returns `{id:"abc"}`.
     - Thumbnail POST returns 200.
     - `videos.list` returns `{items:[{status:{privacyStatus:"public",uploadStatus:"processed"}}]}`.
     - Expect `{kind:"posted", url:"https://youtube.com/shorts/abc"}`.
  2. **YouTube forced private:** `privacyStatus:"private"` → `needs_action` with a note containing "YouTube Studio".
  3. **YouTube thumbnail 403:** still posted (best effort).
  4. **Instagram:**
     - Container POST returns `{id:"c1", uri:"https://rupload.facebook.com/ig-api-upload/v24.0/c1"}`.
     - Upload POST has headers `offset: "0"`, `file_size: "1024"` and `Authorization: "OAuth T"`.
     - Status polls `IN_PROGRESS`, then `FINISHED`.
     - `media_publish` returns `{id:"m1"}`, and the permalink call returns `{permalink:"https://instagram.com/reel/x"}`.
     - Expect posted with that URL.
  5. **Instagram container `ERROR`:** `PlatformError`, not retryable.
  6. **TikTok inbox:**
     - Init returns `{data:{publish_id:"p1", upload_url:"https://up"}, error:{code:"ok"}}`.
     - PUT to `https://up` has `Content-Range: bytes 0-1023/1024`.
     - Status fetch returns `SEND_TO_USER_INBOX`.
     - Expect `needs_action` with a note containing "inbox".
  7. **TikTok direct:** `creator_info` returns `{data:{privacy_level_options:["SELF_ONLY"]}}`, then init with `post_info.privacy_level === "SELF_ONLY"`, then `PUBLISH_COMPLETE`. Expect posted with a note "Posted as private (app not audited)".
  8. **`httpError`:** 401 → auth, 429 → retryable, 400 → neither.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Endpoints and bodies:
  - **YouTube:**
    - Init: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with headers `Authorization: Bearer`, `Content-Type: application/json; charset=UTF-8`, `X-Upload-Content-Type: video/mp4`, `X-Upload-Content-Length`. Body: `{snippet:{title, description, tags, categoryId:"22"}, status:{privacyStatus:"public", selfDeclaredMadeForKids:false}}`.
    - Upload: `PUT <Location>` with the bytes (`await openAsBlob(file)`).
    - Thumbnail (when `thumbFile`): `POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=` with an `image/jpeg` blob. Errors are only logged.
    - Status: poll `GET https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=` every 10 s, at most 60 times, until `uploadStatus` is `processed`, `failed` or `rejected` (failed or rejected → `PlatformError` with `rejectionReason`/`failureReason`, not retryable). Then, if `privacyStatus !== "public"`, return `needs_action` with the note "Uploaded as private (Google project not audited yet). Open YouTube Studio and set it to Public." and `url: https://studio.youtube.com/video/<id>/edit`. Otherwise posted with the Shorts URL.
    - Account: `GET …/channels?part=snippet&mine=true` gives `{id, name: snippet.title, avatar: snippet.thumbnails.default.url}`.
  - **Instagram** (`G = https://graph.facebook.com/v24.0`):
    - Container: `POST ${G}/${igUserId}/media` with form `media_type=REELS, upload_type=resumable, caption, share_to_feed=true, thumb_offset=<ms when thumbAt>, access_token`.
    - Upload: `POST (res.uri ?? https://rupload.facebook.com/ig-api-upload/v24.0/${id})` with headers `Authorization: OAuth ${token}`, `offset: 0`, `file_size`, and the file blob as body.
    - Status: poll `GET ${G}/${id}?fields=status_code,status&access_token` every 5 s, at most 120 times. `FINISHED` → publish. `ERROR` or `EXPIRED` → `PlatformError(status)`, not retryable.
    - Publish: `POST ${G}/${igUserId}/media_publish` with `creation_id, access_token`, then `GET ${G}/${mediaId}?fields=permalink`.
    - Accounts: `GET ${G}/me/accounts?fields=name,instagram_business_account{id,username,profile_picture_url}&access_token`, keeping the Pages that have one.
  - **TikTok** (`T = https://open.tiktokapis.com/v2`):
    - Chunking: `size ≤ 64 MB` → one chunk, otherwise `chunk = 10 MB` and `count = Math.floor(size/chunk)` (the last chunk takes the remainder).
    - Inbox init: `POST ${T}/post/publish/inbox/video/init/` with JSON `{source_info:{source:"FILE_UPLOAD", video_size, chunk_size, total_chunk_count}}`.
    - Direct: first `POST ${T}/post/publish/creator_info/query/`. Pick `PUBLIC_TO_EVERYONE` if it's listed, otherwise the first option. Then `POST ${T}/post/publish/video/init/` with `{post_info:{title: caption, privacy_level, video_cover_timestamp_ms, disable_comment:false, disable_duet:false, disable_stitch:false}, source_info:{…}}`.
    - Upload: `PUT upload_url` per chunk with `Content-Type: video/mp4`, `Content-Length`, and `Content-Range: bytes a-b/size`.
    - Status: poll `POST ${T}/post/publish/status/fetch/` with `{publish_id}` every 5 s, at most 120 times.
      - Inbox mode: `SEND_TO_USER_INBOX` → `needs_action` with the note "Open TikTok, tap the inbox notification and post it. Caption copied below."
      - `PUBLISH_COMPLETE` → posted. The id is `publicaly_available_post_id[0]` if present, else `publish_id`. The URL is `https://www.tiktok.com/@<username>/video/<id>` when there's a username, otherwise undefined. If the privacy wasn't public, add the note "Posted as private (app not audited)".
      - `FAILED` → `PlatformError(fail_reason)`.
    - Errors: a body with `error.code !== "ok"` becomes a `PlatformError`, with auth = `access_token_invalid` or `scope_not_authorized`.
    - Account: `GET ${T}/user/info/?fields=open_id,display_name,avatar_url,username`.
- [ ] **Step 4: Run it.** `pnpm vitest run test/platforms.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add server/platforms test/platforms.test.ts && git commit -m "Posting: YouTube, Instagram (resumable) and TikTok (inbox/direct) clients"`

---

### Task 5: Queue store and transitions

**Files:**
- Create: `server/queue.ts`
- Test: `test/queue.test.ts`

**Interfaces:**
- Consumes: `allocateSlot`, `postTextFor`, `QueueEntry`, `publicAccounts`.
- Produces (all pure functions take and return `QueueEntry[]`; the store wraps them):
  - `upsertForRender(entries, c: { jobId; n; clipTitle; videoUrl?; thumbUrl?; thumbAt?; publish?: Publish; hook?: string }, platforms: Platform[], now): QueueEntry[]`
  - `approve(entries, jobId, n | undefined, opts: { platforms?: Platform[]; audienceTz: string; now: Date }): { entries; scheduled: QueueEntry[] }`
  - `reject(entries, key)`, `remove(entries, key)`, `move(entries, key, slotAt)` (applies to all of the clip's scheduled platforms when `allPlatforms`), `editText(entries, key, text)`, `postNow(entries, key, now)`, `retry(entries, key, now)`
  - `reconcileMissed(entries, audienceTz, now): QueueEntry[]` (under 2 h late → stays due; more → new slot plus a history note)
  - `recoverInterrupted(entries, now)` (`posting` → `scheduled` with `slotAt = now` and the note "Interrupted, retrying")
  - `markResult(entries, key, outcome | error, now)` (applies retries: `[2, 10, 30]` minutes, then `failed`; auth → `needs_action`)
  - `reconnected(entries, platform, audienceTz, now)` (that platform's `needs_action` entries flagged `auth` → `scheduled`, with a new slot if theirs has passed)
  - `summary(entries, now): { review: number; nextPost?: { at: number; platforms: Platform[] }; activeCount: number }`
  - Store: `queue()` returns `{ list(); mutate(fn: (e: QueueEntry[]) => QueueEntry[]): QueueEntry[]; file() }`. It's backed by `<dataDir>/queue.json` with an atomic write and a `globalThis` cache, and it runs `recoverInterrupted` on first load.
  - `QueueEntry` gains `authBlocked?: boolean` (used by `reconnected`).

- [ ] **Step 1: Write the failing tests** `test/queue.test.ts`. Use fixed `now = new Date("2026-09-23T10:00:00Z")` and `tz = "America/New_York"`. Cases:
  1. `upsertForRender` creates one `review` entry per platform with the text from `postTextFor`. Calling it again for the same clip doesn't duplicate.
  2. Re-render: a `scheduled` entry keeps its `slotAt` and status, and only `videoUrl`/`thumbUrl` change. `posted`, `posting` and `rejected` entries stay untouched.
  3. `approve(jobId, n)` gives every `review` platform entry of that clip one shared `slotAt` and status `scheduled`. `approve(jobId)` (whole video) gives clips in `n` order slots that never break 2/day or 4 h.
  4. `approve` with `platforms: ["youtube"]` marks the clip's other platforms `rejected`.
  5. `reject` frees the slot. A later approve can reuse that time.
  6. `reconcileMissed`: a slot 1 h 59 min ago stays due, unchanged. A slot 2 h 1 min ago moves to a future slot, with a history entry containing "Missed".
  7. `recoverInterrupted`: `posting` → `scheduled`, due now, with history "Interrupted, retrying".
  8. `markResult` with a retryable error, three times: `nextTryAt` +2, +10, +30 minutes, then `failed` on the 4th. An auth error → `needs_action` with `authBlocked: true`. A `needs_action` outcome → status `needs_action` with its note and URL. Posted → `posted` with the result.
  9. `summary` counts review entries and returns the earliest scheduled time with its platforms.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** `server/queue.ts`:
  - Use the pure functions above.
  - `approve` collects `taken` from `scheduled`/`posting` entries plus `posted` entries in the last 24 h (using `result` time = `updatedAt`), then calls `allocateSlot(taken, platforms, tz, now)` per clip in order and adds each result to `taken`. When it returns `null`, keep the entry in `review` and add the history note "No free slot in the next 14 days".
  - Every mutation appends `{t, msg}` to `history` (capped at 50) and sets `updatedAt`.
- [ ] **Step 4: Run it.** `pnpm vitest run test/queue.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add server/queue.ts lib/types.ts test/queue.test.ts && git commit -m "Posting: queue store with review → scheduled → posted transitions"`

---

### Task 6: Poster loop, instrumentation and render hook

**Files:**
- Create: `server/poster.ts`, `instrumentation.ts`
- Modify: `server/jobs.ts` (renderOne → queue upsert; `JobSettings.autoPost`), `components/url-form.tsx` (Auto-post checkbox)
- Test: `test/poster.test.ts`

**Interfaces:**
- Consumes: the queue store (Task 5), `getAccessToken`/`loadAccounts` (Task 3), and the clients (Task 4).
- Produces:
  - `tick(deps?: Partial<PosterDeps>): Promise<void>`
  - `startPoster(): void` (idempotent on `globalThis.__capyPoster`, `setInterval` every 30 s, first tick after 5 s)
  - `PosterDeps = { now(): Date; clients: Record<Platform, (job: PostJob, a: StoredAccount, token: string) => Promise<PostOutcome>>; token(p: Platform): Promise<string>; fileFor(e: QueueEntry): string | undefined; paused(): boolean; audienceTz(): string }`
  - `onRendered(job: JobState, c: ClipState): void` (exported from `server/poster.ts` and called by `jobs.ts`)

- [ ] **Step 1: Write the failing tests** `test/poster.test.ts`. Use a temp `CAPY_DATA_DIR`, seed the queue, and inject `deps`. Cases:
  1. A due `scheduled` entry gets the client called once and becomes `posted`. A future one isn't touched.
  2. `paused()` true: nothing posts.
  3. `fileFor` returns undefined → `needs_action` "Clip file missing, re-render it", and no client call.
  4. Two due entries on the same platform: only one client call in progress at a time. Run `tick()` twice concurrently with a client that resolves late, and expect the second tick not to re-post an entry already `posting`.
  5. The client throws `PlatformError(retryable)` → `nextTryAt` set. The next tick before `nextTryAt` doesn't call the client again.
  6. `token()` throws `AuthError` → `needs_action` with `authBlocked`, and no client call.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement `server/poster.ts`.** `tick`:
  1. If `paused()`, return.
  2. `queue().mutate((e) => reconcileMissed(e, tz, now))`.
  3. Find the due entries: (`scheduled` with `slotAt ≤ now`) or (`failed` with `nextTryAt ≤ now` and `attempts < 4`) on platforms not in `busy`.
  4. For each, mark it `posting` and add its platform to `busy`.
  5. In parallel, one per platform: build the `PostJob` from `fileFor(e)`, the thumbnail file (the rendered `.jpg` next to the mp4), `e.text` and `e.thumbAt`. Get the token and call the client, then apply `markResult`. Remove the platform from `busy` in `finally`.
  - Default deps:
    - `clients` wrap `postYouTube`, `postInstagram` (with `igUserId` from the account) and `postTikTok` (with `mode`).
    - `fileFor` resolves the clip's rendered file through `jobs().get(jobId)` and `renderedFile(job, clip)`.
    - `audienceTz` comes from `audienceTz(effective().postingAudience)`.
    - `paused` comes from `loadSettings().postingPaused`.
  - `onRendered(job, c)`: when `job.settings.autoPost !== false`, get the platforms that are connected and have auto-post on from `publicAccounts()`. If there are any, `queue().mutate(e => upsertForRender(e, {...}, platforms, new Date()))`.
- [ ] **Step 4: Instrumentation.** Create `instrumentation.ts` at the repo root:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startPoster } = await import("./server/poster");
  startPoster();
}
```

- [ ] **Step 5: Render hook.** In `server/jobs.ts` `renderOne`, after `c.render = { status: "done", … }`, call `onRendered(job, c)`. Wrap it in try/catch and log failures as "auto-post: …".
- [ ] **Step 6: Auto-post setting.** Add `autoPost?: boolean` to `JobSettings`. In the URL form, add a checkbox field "Auto-post" (default checked). Hint: "Rendered clips wait in Queue for your OK."
- [ ] **Step 7: Run it.** `pnpm vitest run && pnpm typecheck && pnpm build`. Expected: PASS.
- [ ] **Step 8: Commit.** `git add -A server instrumentation.ts components lib test && git commit -m "Posting: background poster, instrumentation start, rendered clips enter review"`

---

### Task 7: API routes

**Files:**
- Create:
  - `app/api/accounts/route.ts` (GET)
  - `app/api/accounts/[platform]/route.ts` (PUT, DELETE)
  - `app/api/accounts/[platform]/connect/route.ts` (POST)
  - `app/api/accounts/[platform]/callback/route.ts` (POST `{ url }`: the paste-back fallback)
  - `app/api/queue/route.ts` (GET)
  - `app/api/queue/summary/route.ts` (GET)
  - `app/api/queue/approve/route.ts` (POST)
  - `app/api/queue/tick/route.ts` (POST)
  - `app/api/queue/[key]/route.ts` (PATCH, DELETE)
  - `app/api/queue/[key]/[action]/route.ts` (POST: `reject | post-now | retry`)
- Modify: `app/api/settings/route.ts` (`postingAudience`, `postingPaused` in Patch), `server/settings.ts` (clean whitelist, effective)

**Interfaces:**
- Produces: the HTTP API in the spec's API summary table. The `[key]` path segment is `encodeURIComponent(key)`.
- `POST /api/accounts/[platform]/connect` → `{ url, redirectUri }`. It starts `listenOnce` with `onCode` = exchange, fetch the account (Instagram: choices; with exactly one, set `igUserId`), save, then `queue().mutate(e => reconnected(e, platform, tz, now))`.
- `POST /api/queue/approve` with body `{ jobId: string; n?: number; platforms?: Platform[] }` → `{ scheduled: QueueEntry[] }`.

- [ ] **Step 1:** Write the routes with zod body validation (`z.strictObject`), returning `NextResponse.json` and `{ error }` with 400/404. PUT accounts accepts `{ clientId?, clientSecret?, autoPost?, mode?, igUserId? }`. A secret that starts with `••••` is ignored, the same as `apiKey`.
- [ ] **Step 2:** Add a route test `test/queue-routes.test.ts`. It imports the route handlers directly, calls them with `new Request(...)` against a temp data dir, and covers: GET queue is empty → `[]`; approve on a review entry → 200 with a slot; approve with an unknown jobId → 404; DELETE on an unknown key → 404.
- [ ] **Step 3: Run it.** `pnpm vitest run && pnpm typecheck && pnpm build`. Expected: PASS.
- [ ] **Step 4: Commit.** `git commit -am "Posting: accounts, OAuth connect and queue API routes"` (after `git add app server test`)

---

### Task 8: Settings → Accounts and the setup guide

**Files:**
- Create: `components/accounts-panel.tsx`, `app/settings/posting-setup/page.tsx`
- Modify: `app/settings/page.tsx` (render `<AccountsPanel />` under the existing form), `components/settings-form.tsx` ("Posting audience" select from `AUDIENCES`, saved as `postingAudience`)

- [ ] **Step 1: Accounts panel.** `AccountsPanel` loads `GET /api/accounts`, plus `GET /api/queue/summary` for a "Posting paused" toggle that saves `postingPaused` through `/api/settings`. Each platform card shows:
  - The status chip: Not set up / Connected as <name> / Reconnect needed.
  - Client ID and Client secret inputs, saved through PUT.
  - **Connect**, which POSTs connect, opens `url` with `window.open(url, "_blank")` (Electron's `setWindowOpenHandler` sends it to the system browser), then polls `GET /api/accounts` every 2 s for up to 5 minutes until connected.
  - A collapsible "Didn't come back? Paste the address from your browser" input that POSTs to `/callback`.
  - An "Auto-post rendered clips here" toggle.
  - TikTok only: a mode select ("Send to my TikTok inbox (works now)" / "Direct post (after TikTok approves your app)").
  - Instagram with `choices.length > 1`: an account select that PUTs `igUserId`.
  - Disconnect.
  - Copy: "Uses your own free developer app. Nothing is sent to capy's makers." and a link to `/settings/posting-setup#<platform>`.
- [ ] **Step 2: Setup guide page.** One section per platform with numbered steps, including the exact redirect URI to paste:
  - **YouTube:**
    1. Create a Google Cloud project.
    2. Enable YouTube Data API v3.
    3. On the OAuth consent screen (External), add the scopes `youtube.upload` and `youtube.readonly`, then **Publish app** to "In production" (skip verification; you'll see an "unverified app" warning you can click through). Testing mode signs you out every 7 days.
    4. Credentials → OAuth client ID → **Desktop app**, and copy the ID and secret.
    5. Note: until you pass the free YouTube API audit (link to the audit form), uploads stay private and capy reminds you to switch them to Public.
  - **Instagram:**
    1. Switch your Instagram to a Professional (Business or Creator) account and link it to a Facebook Page.
    2. In Meta for Developers, create a **Business** app and add **Facebook Login for Business** and **Instagram Graph API**.
    3. Add `http://localhost:53682/callback` to the Valid OAuth Redirect URIs.
    4. Keep the app in Development mode (it works for your own account).
    5. Copy the App ID and App Secret.
  - **TikTok:**
    1. Create an app at developers.tiktok.com.
    2. Add **Login Kit** with platform **Desktop** and the redirect URI `http://localhost:53682/callback`, and add **Content Posting API**.
    3. Request the scopes `user.info.basic` and `video.upload`.
    4. Add yourself as a target user in Sandbox, or submit the app for review.
    5. Copy the Client key and Client secret.
    6. Note: until TikTok audits your app, posts go to your TikTok inbox and you tap Post.
- [ ] **Step 3: Verify.** `pnpm typecheck && pnpm build`. Then check `/settings` in the browser preview: the cards render, saving a client ID round-trips, and the secret comes back redacted.
- [ ] **Step 4: Commit.** `git add components app && git commit -m "Posting: Settings → Accounts panel and setup guide"`

---

### Task 9: Queue page, header badge, clip page Approve/Reject and own slot

**Files:**
- Create: `app/queue/page.tsx`, `components/queue-view.tsx`, `components/review-card.tsx`, `hooks/use-queue.ts`
- Modify: `app/layout.tsx` (Queue nav link with a review-count badge, through a small client component `components/queue-badge.tsx`), `components/post-time.tsx` (clip-aware mode), the clip page component that renders `PostTime` (`components/clip-editor.tsx` or `components/publish-panel.tsx`; find the usage with grep)

- [ ] **Step 1: `useQueue()`.** Polls `GET /api/queue` every 5 s while the tab is visible, and returns `{ entries, summary, refresh }`.
- [ ] **Step 2: `ReviewCard`.**
  - One card per clip (group the `review` entries by `jobId:n`): a 9:16 `<video src={videoUrl} controls preload="metadata">` with the poster set to `thumbUrl`, and the clip title.
  - A checkbox per platform (default checked).
  - Editable text per platform: YouTube title and description; Instagram caption; TikTok caption. Edits PATCH on blur.
  - Buttons:
    - **Approve** POSTs to approve with `{jobId, n, platforms}`, and toasts "Scheduled for Thu 5:00 PM ET".
    - **Reject** POSTs reject for each entry.
  - "Next free slot" preview text comes from `summary`.
- [ ] **Step 3: `QueueView`.**
  - **"Waiting for your OK (N)"** section: the review cards, plus "Approve all from <video title>" per job.
  - **"Scheduled & posted"** section: grouped by audience-local day ("Thu Oct 8"). One row per clip with its time and one chip per platform:
    - scheduled: clock icon
    - posting: spinner
    - posted: green, linked to `result.url`
    - needs_action: amber, with the note and link (and a Copy caption button for the TikTok inbox)
    - failed: red, with the error and Retry
  - Row actions: **Post now**, **Move** (a `datetime-local` input in the audience zone, converted to UTC on the client with the same `fromZoned` logic exported from `lib/post-time.ts` as `zonedToUtc`), **Remove**.
  - An expandable history list.
- [ ] **Step 4: Header and clip page.**
  - The header gets a **Queue** link (lucide `CalendarClock`) with a badge for `summary.review` when it's above 0.
  - On the clip page, `PostTime` takes optional `jobId` and `n`:
    - With queue entries for that clip, it shows the status per platform and the slot instead of the generic recommendation.
    - With `review` entries, it shows **Approve** / **Reject** and "Approve to schedule (next free: …)".
    - With no entries and no connected accounts, it keeps today's generic card plus a link "Connect accounts to auto-post".
- [ ] **Step 5: Verify.** `pnpm typecheck && pnpm build`. Then, in the browser preview, seed a review entry by temporarily connecting a fake account: write `accounts.json` in the preview's data dir with a dummy token, and render one clip. Check the review card plays the clip, Approve gives a slot, the badge count drops, and the clip page shows the slot. Restore `accounts.json` afterwards.
- [ ] **Step 6: Commit.** `git add app components hooks lib && git commit -m "Posting: Queue page with review cards, header badge, clip-page approve and slot"`

---

### Task 10: Menu-bar tray and wake handling (Electron)

**Files:**
- Create: `electron/tray.ts`
- Modify: `electron/main.ts`, `scripts/desktop-bundle.mjs` (only if new entry files need bundling; `tray.ts` is imported by `main.ts`, so the esbuild bundle picks it up), `build/` (a `trayTemplate.png` 16×16 and `@2x`, a monochrome template image generated from `public/capy-mark.png` with `sips`, or drawn)
- Test: `test/tray.test.ts` for the pure `trayMenuModel(summary, paused)`

**Interfaces:**
- Produces: `trayMenuModel(s: { nextPost?: { at: number; platforms: Platform[] }; activeCount: number }, paused: boolean, tz: string): { label: string; enabled?: boolean; id?: string }[]` (pure); `createTray(o: { serverUrl(): string | undefined; show(): void; quit(): void }): { refresh(): Promise<void>; destroy(): void; hasActive(): boolean }`.

- [ ] **Step 1: Write the failing test** for `trayMenuModel`:
  - With a next post, the first label is `Next post: Fri 5:00 PM · Instagram, TikTok`.
  - Without one: `No posts scheduled`.
  - It includes `Open capy`, `Pause posting` (or `Resume posting` when paused) and `Quit capy`.
- [ ] **Step 2: Run it.** Expected: FAIL. **Step 3:** Implement `electron/tray.ts`.
  - `Tray` gets the template image, and the menu is rebuilt from `trayMenuModel`.
  - `refresh()` fetches `${serverUrl}/api/queue/summary`, plus `/api/settings` for `postingPaused`, every 60 s and on demand.
  - The pause item PUTs `postingPaused` through `/api/settings`.
- [ ] **Step 4: Change `main.ts`.**
  - Create the tray after the server starts.
  - `window-all-closed`: if `tray.hasActive()`, call `app.dock?.hide()` and keep running; otherwise `app.quit()` on all platforms. That changes today's darwin behaviour of staying alive with no window: with nothing queued, closing quits.
  - `showWindow()` calls `app.dock?.show()`.
  - `powerMonitor.on("resume", …)` POSTs `${server.url}/api/queue/tick`.
  - Menu "Quit capy" sets `quitting` and quits.
- [ ] **Step 5: Verify.** `pnpm vitest run && pnpm typecheck && pnpm desktop:bundle`. Expected: PASS, and the bundle builds. Then run `pnpm desktop:dev`, check the tray icon shows "No posts scheduled", and quit from the tray.
- [ ] **Step 6: Commit.** `git add electron build test scripts && git commit -m "Desktop: menu-bar tray keeps capy posting while the window is closed"`

---

### Task 11: End-to-end verification and handoff

- [ ] **Step 1: Without real accounts.** In the browser preview:
  - Fake-connect YouTube by writing `accounts.json` with a dummy token and a stub `clientId`, render a clip, approve it, and set its slot to now with Post now.
  - Expect the poster to try, get a 401 from Google, and mark the entry "Needs action: Reconnect YouTube". That proves the loop, the error mapping and the UI.
  - Remove the fake account.
- [ ] **Step 2: With the user's real apps.** The user creates their developer apps following `/settings/posting-setup` and clicks Connect. Verify each platform's sign-in completes against the loopback listener. If Meta rejects the http localhost redirect, the paste-back fallback is the path, and the guide gets a note.
- [ ] **Step 3: Post one real clip to each platform:**
  - YouTube: expect `needs_action`, forced private, until the audit passes.
  - Instagram: expect posted, with a permalink.
  - TikTok: expect inbox `needs_action`.
  Check the links and notes on the Queue page.
- [ ] **Step 4: Final checks.** `pnpm test && pnpm typecheck && pnpm build`, then commit any fixes.
