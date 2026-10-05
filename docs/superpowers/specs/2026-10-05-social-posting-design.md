# Posting to YouTube, Instagram and TikTok — design

Date: 2026-10-05 · Status: approved in chat, awaiting spec review

Part B of two. Part A, better picks and US reach, is in `2026-10-05-picks-and-us-reach-design.md`.

## Goal

Post rendered clips to YouTube Shorts, Instagram Reels and TikTok without a paid service. Capy uses each
platform's free official API with the user's own developer apps, and spreads posts over good time slots instead
of recommending the same Friday slot for every clip.

What the user said:
- No paid subscriptions.
- Every rendered clip goes into the queue automatically, but the user must be able to watch and approve each one
  before it gets a slot.
- At most 2 posts a day per platform.
- Capy keeps running in the menu bar so it can post at slot times.

Success means: connect three accounts once, approve clips in a review list, and they go out on their own at
staggered good times. Each post's result (link, or what the user needs to do) is shown in capy.

## Platform constraints (checked 2026-10-05 against the official docs)

| | API | Free-tier limit that shapes the design |
|---|---|---|
| YouTube | Data API v3, `videos.insert` (resumable) | Videos uploaded by unverified API projects created after 2020-07-28 are **forced private** until a free compliance audit passes. A consent screen in "Testing" status issues refresh tokens that expire after 7 days. |
| Instagram | Graph API with **Facebook Login for Business**, resumable upload via `rupload.facebook.com` | Uploading local files only works with Facebook Login for Business, not Instagram Login. It needs an Instagram Business or Creator account linked to a Facebook Page. A development-mode app works for the app's own roles without App Review. There's no scheduling API. |
| TikTok | Content Posting API | Unaudited clients' direct posts are **private-only**. The Upload flow (`video.upload`) sends the video to the user's TikTok inbox, and the user finishes posting in the app. Login Kit for desktop allows `http://127.0.0.1:<port>` redirects. There's no scheduling API. |

## B1. Accounts

- **Settings → Accounts** has one card per platform with:
  - client ID and client secret fields (for the user's own developer app)
  - Connect, Disconnect or Reconnect
  - the connected account's name and avatar
  - an "Auto-post to this platform" toggle
  - a "How to set this up" link
- New in-app guide `docs/posting-setup.md` (rendered at `/settings/posting-setup`), one section per platform,
  including: YouTube's OAuth client type "Desktop" and publishing the consent screen to "In production" without
  verification, Instagram's Business/Creator account plus Page linking, and the TikTok desktop redirect URI.
- **OAuth:**
  - `POST /api/accounts/[platform]/connect` starts a one-shot loopback listener on `127.0.0.1:53682` (fixed port,
    closed after the callback or a 5-minute timeout) and returns the authorize URL.
  - The UI opens it in the system browser (Electron `shell.openExternal`, or `window.open` in browser mode).
  - Google and TikTok use PKCE. The callback exchanges the code, stores the tokens and shows a "Connected, you
    can close this tab" page.
  - Scopes:
    - YouTube: `youtube.upload` and `youtube.readonly`
    - Instagram: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`,
      `business_management`
    - TikTok: `user.info.basic`, `video.upload`, plus `video.publish` only when Direct post mode is on
- **Storage:** `server/accounts.ts` is the only reader and writer of `<dataDir>/accounts.json` (mode 0600,
  atomic write, the same pattern as `server/settings.ts`). It holds per-platform `{ clientId, clientSecret,
  tokens, expiresAt, account, autoPost }`. `GET /api/accounts` returns everything redacted (no secrets or tokens).
- **Refresh:** `getAccessToken(platform)` refreshes when the token is within 5 minutes of expiry.
  - Google: refresh token.
  - TikTok: `refresh_token` grant (the access token lasts 24 h, the refresh token 365 days).
  - Meta: exchange for a long-lived token at connect time, refresh when under 7 days remain.
  - A refresh that fails with an auth error sets `needsReconnect`.
- **Instagram account resolution** at connect: `me/accounts` → the Page's `instagram_business_account`. With more
  than one, the user picks one in the card.

## B2. Review and queue

- **Store:** `server/queue.ts` is the only reader and writer of `<dataDir>/queue.json`. Entries:
  `{ key: "<jobId>:<n>:<platform>", jobId, n, platform, status, slotAt?, text, attempts, nextTryAt?, result?, error?, history[] }`.
  - `status` is one of `review | scheduled | posting | posted | needs_action | failed | rejected`.
  - `result` is `{ id, url, note? }`.
  - `text` is the platform text, editable:
    - YouTube: `{ title, description, tags }`
    - Instagram: `{ caption }`
    - TikTok: `{ caption }`
- **Entering the queue:** when a render finishes (`renderOne` in `server/jobs.ts`) and the job has
  `settings.autoPost !== false`, capy upserts one `review` entry per platform that is connected and has auto-post
  on. It doesn't change an entry that's already `posted`. A `scheduled` entry keeps its slot and will post the new
  file. `rejected` entries stay rejected.
- **Text** comes from `clip.publish`:
  - YouTube: ytTitle, description, hashtags as tags.
  - Instagram: hook or title line, description, up to 30 hashtags, limited to 2,200 characters.
  - TikTok: ytTitle plus hashtags, limited to 2,200 characters.
- **Review:** nothing gets a slot until the user approves it. The new **Queue page** (`/queue`, header link with a
  badge for the review count) has two sections:
  1. **Waiting for your OK:** one card per clip with an inline 9:16 player, a platform checkbox for each pending
     platform, the editable text per platform, and **Approve**, **Reject** and **Approve all from this video**.
  2. **Scheduled and posted:** grouped by day in the audience time zone, with a status chip and link per platform
     and **Post now**, **Move** (date and time picker), **Remove**, **Retry**.
- The clip page shows the same Approve and Reject buttons next to the player. Its "Best time to post" panel
  (`components/post-time.tsx`) shows **that clip's own slot** and the status per platform once scheduled.
  Before approval it shows "Approve to schedule (next free: Thu 5:00 PM)".
- **Slots:** the pure function `allocateSlot(taken, platforms, audienceTz, now)` in `lib/post-time.ts` returns the
  earliest candidate at least 30 minutes away where **every** chosen platform has fewer than 2 posts that
  audience-local day and no post within 4 h.
  - Candidate hours per weekday extend the existing `SLOTS` table so that two slots 4 h apart always exist, for
    example Wed `[16, 12, 20]` and Mon `[15, 11, 19]`.
  - Candidates are tried in time order, and within a day in rank order.
  - `taken` covers every `scheduled` or `posting` entry, and `posted` entries from the last 24 h.
- Approve assigns one shared `slotAt` to all of the clip's approved platforms. Removing or rejecting frees the
  slot; already-scheduled entries don't move.
- **Audience time zone:** `AppSettings.postingAudience` (an `AUDIENCES` id, default `us-east`). The localStorage
  value in `PostTime` is dropped.

## B3. Posting

- `server/poster.ts` runs a tick every 30 s, started once from the server boot path. It's a `globalThis`
  singleton, the same pattern as the job manager, so dev reloads don't start a second one.
- Each tick takes entries that are `scheduled` with `slotAt ≤ now`, or `failed` with `nextTryAt ≤ now`. It runs
  one post at a time per platform.
- Before uploading, it checks that the rendered mp4 exists. If not: `needs_action: "Clip file missing, re-render
  it"`.
- **YouTube** (`server/platforms/youtube.ts`):
  1. Resumable `videos.insert` with snippet `{ title, description, tags, categoryId: "22" }` and status
     `{ privacyStatus: "public", selfDeclaredMadeForKids: false }`.
  2. Best-effort `thumbnails.set` with the chosen thumbnail. Failures are only logged.
  3. Poll `videos.list?part=status,processingDetails` until processed (at most 10 minutes).
  4. If `privacyStatus` is not `public`: `needs_action: "Uploaded as private (Google project not audited yet).
     Open YouTube Studio and set it to Public."` with the Studio link. Otherwise `posted` with the
     `https://youtube.com/shorts/<id>` URL.
- **Instagram** (`server/platforms/instagram.ts`):
  1. `POST graph.facebook.com/<igUserId>/media` with `media_type=REELS`, `upload_type=resumable`, `caption`,
     `share_to_feed=true`, `thumb_offset=<thumbAt ms>`.
  2. `POST rupload.facebook.com/ig-api-upload/<container>` with the file and the `offset` and `file_size`
     headers.
  3. Poll the container's `status_code` until `FINISHED` (at most 10 minutes; `ERROR` fails the post).
  4. `media_publish`, then read `permalink`, then `posted`.
- **TikTok** (`server/platforms/tiktok.ts`):
  - **Inbox mode (default):** `POST /v2/post/publish/inbox/video/init/` with `source: FILE_UPLOAD`, then upload
    the chunks to the returned `upload_url`, then poll `status/fetch` until `SEND_TO_USER_INBOX`. The entry
    becomes `needs_action: "Open TikTok, tap the inbox notification and post"`.
    - The caption can't be passed in inbox mode, so the card shows it with a Copy button.
  - **Direct post mode** (Settings, for after the audit): `/v2/post/publish/video/init/` with `post_info: { title:
    caption, privacy_level, video_cover_timestamp_ms }`.
    - `privacy_level` comes from `creator_info/query`: `PUBLIC_TO_EVERYONE` when allowed, otherwise
      `SELF_ONLY`, and then the entry notes "Posted as private (app not audited)".
- **Retries:**
  - Network errors, 5xx and 429 use backoff (2, 10 and 30 minutes), then `failed`.
  - 401, 403 and `invalid_grant` give `needs_action: "Reconnect <platform>"` and set `needsReconnect`. When a
    platform is reconnected, its waiting entries go back to `scheduled` and get a new slot if theirs has passed.
  - Validation errors (4xx) become `failed` right away, with the platform's message.
- **History:** every state change is appended to the entry's `history` (time and message), shown in the
  expandable details on the Queue page.

## B4. Menu bar and missed slots

- **Electron** (`electron/main.ts`, new `electron/tray.ts`): when the last window closes and the queue has
  `scheduled` or `posting` entries, keep running (hide the Dock icon) with a Tray icon. Its menu:
  - "Next post: Fri 5:00 PM · Instagram, TikTok" (read from `GET /api/queue/summary`)
  - Open capy
  - Pause posting / Resume posting (`AppSettings.postingPaused`)
  - Quit
  With an empty queue, closing the window quits as today. Quit always quits.
- **Missed slots:** a `scheduled` entry whose `slotAt` passed while capy wasn't running or the Mac was asleep:
  - **Under 2 h late:** posts on the next tick.
  - **Later than that:** gets a new slot from `allocateSlot`, and the history notes "Missed Thu 5:00 PM (Mac was
    asleep or capy was closed), moved to Fri 3:00 PM".
  - The Electron main process listens for `powerMonitor` `resume` and asks the server for an immediate tick.
- In browser mode (`pnpm dev`), posting runs while the server runs. There's no tray.

## API summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/accounts` | redacted account state |
| PUT | `/api/accounts/[platform]` | save client ID, secret, auto-post, mode (TikTok) |
| POST | `/api/accounts/[platform]/connect` | start OAuth, returns `{ url }` |
| DELETE | `/api/accounts/[platform]` | disconnect (deletes the stored tokens) |
| GET | `/api/queue` | all entries plus the next-free-slot preview |
| GET | `/api/queue/summary` | next post, counts (tray, header badge) |
| PATCH | `/api/queue/[key]` | edit text or platform selection; move (`slotAt`) |
| POST | `/api/queue/approve` | `{ jobId, n? }` approves one clip or the whole video, assigning slots |
| POST | `/api/queue/[key]/reject` · `/post-now` · `/retry` · DELETE | actions |

## Testing

Vitest unit tests:
- `allocateSlot`: 2 a day per platform, 4 h gap, a shared slot across platforms, DST changes in the US, the
  30-minute minimum, freeing after a removal
- queue state changes and duplicate keys: re-render while in review, scheduled, posted or rejected
- the missed-slot rule at 1 h 59 min versus 2 h 1 min late
- the platform clients against a mocked `fetch`: happy path, forced private (YouTube), container `ERROR`
  (Instagram), inbox status (TikTok), 401 → needs_action, 429 → backoff
- text builders: limits and hashtag caps
- token refresh timing and redaction in `GET /api/accounts`

**Probe first (before building on it):** confirm with real developer apps that each platform accepts the
`http://127.0.0.1:53682/callback` redirect, and that the Instagram resumable local upload works for a
development-mode app. If Meta rejects the http loopback redirect, fall back to showing the redirect URL and
having the user paste the final URL back into capy. This only affects the connect step.

**Manual end to end:** connect real accounts, approve one clip, post it to YouTube (expect the forced-private
needs_action), Instagram, and the TikTok inbox. Check the Queue page, the tray summary, and the missed-slot
rescheduling by quitting through a slot.

## Out of scope

Platform audits (Google, TikTok) and Meta App Review, which the user requests once their apps work. Other
platforms (X, Facebook Reels, Threads). Analytics after posting. Posting while the Mac is asleep (it would need
a server).
