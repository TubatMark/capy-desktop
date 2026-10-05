# Creator automation — design

Date: 2026-10-06 · Status: designed and approved for implementation by the user ("do it on your own, no questions")

## Goal

Point capy at YouTube creators, and it notices each new upload and runs the whole pipeline on it:
- picks
- pick reviewer
- footage
- English captions
- render
- a new **AI content reviewer**

The rendered clips then land in **Queue → Waiting for your OK**. The user watches them, reads the AI review, and
chooses which go on to be scheduled and posted. Nothing posts without the user's Approve. The AI content reviewer is
an extra gate, not a replacement.

What the user said:
- monitor creators and get their latest posts
- run everything in the pipeline: link, schedule, post
- an AI reviewer for the clipped content before posting
- the user also reviews, and decides what goes to the posting queue
- don't ask questions

## Decisions made without the user (stated so they can be changed)

1. **No backfill.** Adding a channel records its current uploads as already seen. Only uploads that appear after that
   are processed. An "Also clip the latest upload now" checkbox at add time processes just the newest one.
2. **Skipped:** uploads shorter than 4 minutes (Shorts and teasers have nothing to clip), live or upcoming streams, and
   uploads with no length yet (premieres). Unknown length is checked again next time instead of being marked seen.
3. **Caps protect AI usage and the footage disk:**
   - at most 2 new videos per channel per day, and 6 in total per day
   - 3 clips per video by default
   - over-cap uploads stay pending for the next day
4. **Checked every 60 minutes** while capy runs: in the window or the menu bar, the same as the poster. On start-up the
   check runs after 2 minutes. There's also a "Check now" button.
5. **One video at a time.** Each new video is analyzed, then its selected clips (the ones the pick reviewer passed) are
   rendered automatically. The next video starts once that render is done. This avoids parallel downloads and
   competing renders.
6. **The AI content reviewer runs on every rendered clip that is about to enter the posting queue**, and on every clip
   of an automation job, even with no account connected (the result shows on the clip page). It is text based: it
   reads the clip's final transcript (the English captions when translated), the original transcript, the hook, the
   title, and each platform's caption.
7. **Verdicts:**
   - `ok`
   - `caution`: approve stays one click; the notes are shown
   - `block`: Approve becomes "Post anyway" with a confirmation
   - Blocked clips still reach the review list so the user sees everything automation made.
8. **A desktop notification** appears when new clips are waiting for review: "3 new clips from Canal GNT are waiting
   for your OK".

## Data

`<dataDir>/watch.json`, written only by `server/watch.ts` (atomic write, `globalThis` cache, the same pattern as
`queue.ts`):

```ts
interface WatchedChannel {
  id: string;            // YouTube channel id (UC…)
  name: string;
  url: string;           // https://www.youtube.com/channel/<id>/videos
  handle?: string;       // @canalgnt
  enabled: boolean;
  addedAt: number;
  lastCheckedAt?: number;
  lastError?: string;
  /** Upload ids already handled or deliberately skipped (cap 500, newest kept). */
  seen: string[];
  /** New uploads waiting for a free slot under the daily caps, oldest first. */
  pending: { id: string; title: string; duration?: number; foundAt: number }[];
  /** Videos sent through the pipeline (newest first, cap 50). */
  history: { videoId: string; title: string; at: number; jobId: string; status: "processing" | "rendered" | "error"; error?: string }[];
  settings: { clips: number; minVideoSec: number; perDay: number; audience?: Audience };
}
interface WatchFile { channels: WatchedChannel[]; dailyTotal: number; intervalMin: number }
```

`JobState.automation?: { channelId: string; channelName: string; autoRender: true }` marks jobs that automation
started.

## Components

- `src/youtube.ts`:
  - `resolveChannel(input, yt)` accepts a channel URL, an `@handle`, a `/channel/UC…` URL, or a video URL. It returns
    `{ id, name, handle, url }` via `yt-dlp --flat-playlist --playlist-end 1 -J <…>/videos`.
  - `listUploads(channelUrl, n, yt)` returns `{ id, title, duration?, live }[]`, newest first.
- `server/watch.ts`: the store plus pure functions:
  - `addChannel(file, resolved, uploads, o)` baselines `seen`.
  - `diffUploads(channel, uploads)` returns `{ fresh, skipped, unknown }`.
  - `takeDue(file, now)` applies the caps and returns what may start now.
  - `recordHistory`
  - `dailyCount(channel | file, now)`
- `server/watcher.ts`: the loop.
  - It's guarded by `takePosterLock(<dataDir>/watcher.lock)`, so one watcher runs per data folder.
  - `startWatcher()` is idempotent, never runs during `next build`, and is started from `jobs().init()` and the
    automation routes.
  - Every tick (once a minute): if a check is due, list uploads for each enabled channel, then diff, then add to
    pending. Then, if no automation video is in flight, take one due video and call
    `jobs().create(url, { count, audience, automation })`.
  - Deps are injected (`list`, `createJob`, `now`, `lock`) so the loop is tested without yt-dlp.
- `server/jobs.ts`:
  - At the end of `analyze`, when `job.automation` is set and the job is ready, call `this.render(job.id)` (the
    selected clips).
  - `renderOne`, after a successful render: `const review = await this.contentReview(job, c)` (when the clip will
    enter the queue or the job is automation), stored on `c.contentReview`. Then `onRendered` receives it.
  - Automation history status updates go through `markHistory(jobId, status)` from `server/watch.ts`.
- `src/content-review.ts`:
  - `reviewContent(input, { agent, model })` is one AI call with a JSON schema:
    `{ verdict: "ok" | "caution" | "block", summary, issues: [{ kind, note }], title? }`.
  - Checks:
    - platform policy: violence, sexual content, hate, dangerous acts, medical or financial claims
    - a misleading title or hook
    - the translation keeping the meaning and being natural
    - reused-content risk: a credit line is present, and the clip isn't just a raw copy without context
    - personal data on screen in the transcript: phone numbers, addresses
  - The pure `normalizeContentReview(raw)` clamps the result. Failures give `{ verdict: "caution", summary: "AI review unavailable: …" }`.
- `lib/types.ts`:
  - `ClipState.contentReview?: ContentReview`
  - `QueueEntry.aiReview?: ContentReview`
  - `JobState.automation?`
- `server/queue.ts`: `upsertForRender` copies `aiReview` from `ClipInfo.aiReview` onto new and refreshed entries.
- **UI:**
  - New **Automation page** (`/automation`, header icon with a radar symbol):
    - Add channel: URL or @handle, an "Also clip the latest upload now" checkbox, and Add.
    - Channel cards: name, enabled toggle, settings (clips per video, minimum video length, per day, audience),
      last check and error, pending count, recent history linking to `/v/<jobId>`, and Remove.
    - "Check all now" and the check interval.
    - A short explanation that clips wait for the user's OK in Queue.
  - **Queue review card** shows the AI review as a coloured verdict pill with the summary and issues. A suggested
    title has a "Use" button that PATCHes the YouTube title. `block` turns Approve into "Post anyway…" with
    `confirm()`.
  - **Clip page** (`ClipPosting`) shows the AI review when present.
- **Electron tray:**
  - Shows "Watching N channels".
  - `newReviewNotice(prev, next)` (pure) decides when to show `new Notification(...)`. Clicking it opens `/queue`.
  - The summary API gains `watching: number`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/automation` | channels, intervalMin, dailyTotal, `checking` flag |
| POST | `/api/automation/channels` | `{ input, clipLatest? }` resolves and adds a channel (409 if already watched) |
| PATCH | `/api/automation/channels/[id]` | enabled, settings |
| DELETE | `/api/automation/channels/[id]` | stop watching (jobs and clips stay) |
| POST | `/api/automation/check` | check every channel now |
| PUT | `/api/automation` | `{ intervalMin }` (15–1440) |

The local-only guard (`proxy.ts`) already covers `/api/*`.

## Error handling

- A failed channel list (network, removed channel): `lastError`, retried on the next interval, and the other
  channels are unaffected.
- A failed job analyze: history `error`, the video is marked seen (no retry loop), and the queue moves to the next
  video.
- A render error: the clip shows the usual error, and the content review is skipped for that clip.
- A failed content review: the `caution` fallback. It never blocks the clip from the review list.

## Testing

Vitest:
- `diffUploads`: baseline, fresh order, skips (short, live), unknown length kept for later
- caps in `takeDue`: per channel per day, total per day, pending kept
- `addChannel` with `clipLatest`
- the watcher tick with fakes: a due check lists uploads, starts one job at a time, waits while one is in flight, and
  records history; a list error sets `lastError` and the others continue; a busy lock does nothing
- `normalizeContentReview` and the failure fallback
- the queue copying `aiReview`
- `newReviewNotice`
- the automation routes: add (409 on duplicate), patch, delete

Manual: add a real channel with "clip latest" in the browser preview, watch it create the job, auto-render, and land
clips with AI reviews in Queue.
