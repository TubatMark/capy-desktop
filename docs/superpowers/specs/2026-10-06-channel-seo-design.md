# Channel insights and SEO — design

Date: 2026-10-06. Phase 1 of "plan for reach": channel data and search data first, so the story planner and
assessor (phase 2, separate spec) can use real numbers from the user's own channel instead of guesses.

## What the user asked for

- See everything about their connected YouTube channel inside capy.
- Search insights: what people search for, what ranks, which searches already find the channel.
- Every upload SEO-tuned for their channel: clips and stories alike.
- Fix the SEO of videos already on the channel.
- Free official APIs only (no paid tools). Scores shown as gauges.

Decisions made with the user: channel + SEO first; all four channel features (overview, every video + stats,
search terms that found you, fix old videos' SEO); keyword sources = YouTube autocomplete, top-ranking videos,
the channel's own search terms (no Google Trends); SEO applies to everything capy posts.

## Permissions

The YouTube connection already has `youtube.upload` + `youtube.readonly`. Added:

- `yt-analytics.readonly`: watch time, retention, traffic sources, the search terms that found each video.
- `youtube.force-ssl`: edit an existing video's title/description/tags (fix old videos' SEO).

Both are free. Existing users reconnect once; capy reads the granted `scope` on the stored token and shows
"Reconnect YouTube to unlock search terms and SEO fixes" until both are there. Everything that only needs
`youtube.readonly` works before the reconnect.

## Pieces

### 1. Channel data — `server/channel.ts` (+ `src/youtube-api.ts` for pure parsing)

- `fetchChannel`: `channels.list?mine=true` (snippet, statistics, contentDetails, brandingSettings): name,
  handle, avatar, subscribers, views, video count, uploads playlist, channel keywords, description.
- `fetchVideos`: the uploads playlist (paged, newest 200) → `videos.list` in batches of 50: title, description,
  tags, published, duration, views, likes, comments, thumbnail, made for kids, privacy, category.
- `fetchAnalytics` (needs the Analytics scope): last 28 days by day (views, minutes watched, subscribers
  gained/lost); per video (views, minutes, average view %); traffic sources; top 25 YouTube search terms.
- A snapshot is saved to `<data>/channel.json` with `fetchedAt`. The page shows the snapshot instantly and
  refreshes when it is older than 6 hours or on "Refresh". A failed refresh keeps the old snapshot and says why.
- Quota: Data API reads cost 1 unit per call (a full refresh of 200 videos ≈ 10 units).

### 2. Keyword research — `src/seo/keywords.ts`, `server/seo.ts`

- Autocomplete: `suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=US&q=…` (no key, no
  quota; unofficial, so a failure just drops this source).
- Ranking: `search.list` (type=video, regionCode=US, relevanceLanguage=en, 10 results) then `videos.list` for
  their views and tags. `search.list` costs 100 of the 10,000 daily units and an upload costs 1,600, so searches
  are cached 7 days in `<data>/seo-cache.json` and capped at 25 a day (Pacific day, as Google counts it). Over
  the cap, research continues without this source and says so.
- Your terms: the channel snapshot's search terms.
- `research(seed)` merges them into scored keywords: `{ term, score 0–100, sources, views? }`. Scoring favours
  terms that appear in several sources, rank high in autocomplete, already bring the channel viewers, and whose
  top results have views. Tags seen on several ranking videos become suggested tags.

### 3. SEO score and rewrite — `src/seo/score.ts`, `src/seo/optimize.ts`

- `scoreSeo(text, { keyword, kind: "short" | "kids" })` is deterministic and tested: a 0–100 score from weighted
  checks, each `{ id, label, pass, tip }`:
  keyword early in the title; title length (Shorts search shows ~70 chars); title not shouting (caps);
  keyword in the description's first 150 chars; description substantial; 3–8 hashtags (YouTube shows the first
  three, ignores all of them past 60); `#shorts`; tags present, include the keyword and variants, ≤ 500 chars;
  kids: no "subscribe/like/comment" calls aimed at children, and nothing YouTube's made-for-kids rules forbid.
- `optimizeSeo(input, ai)`: the AI rewrites title, description, hashtags and tags around the best keywords from
  research and the channel's own winning terms, without changing what the video is (no clickbait: the content
  reviewer still checks the result). The rewrite is scored; capy keeps whichever version scores higher.
- `Publish` gains `tags?: string[]` (search tags, separate from hashtags); YouTube uploads use them.

### 4. Where it runs

- Clips: right after the AI content review (same condition: automation or queueing), `optimizeSeo` runs on the
  clip's publish text. The clip keeps `seo: { score, before, keyword, checks }` and the improved publish text;
  the queue entry carries `seo` so Queue review cards show the score.
- Stories: after `storyPublish`, before the kids content review, with `kind: "kids"`.
- Failures never block: SEO unavailable → the original text goes on, `seo` notes why.

### 5. Fixing old videos — `POST /api/channel/videos/:id/seo` and `PUT …/apply`

- Every video in the channel list shows its deterministic score. "Improve" runs research on the video's own
  topic + `optimizeSeo` and shows current vs suggested side by side with both scores.
- "Update on YouTube" sends `videos.update` (part=snippet, keeping categoryId and language) — only after the
  user clicks; nothing on YouTube changes automatically.

### 6. UI

- Sidebar: **Channel** (after Queue). Settings → YouTube card links to it.
- `/channel`: header (avatar, name, handle, refresh time), gauges (Channel SEO = average video score,
  28-day views trend, average % watched, subscribers net), a 28-day views sparkline, traffic sources bars,
  "Searches that found you", and the video table (thumbnail, title, published, views, likes, avg % watched,
  SEO gauge) with Improve → side-by-side panel.
- `/channel` → **Keywords** tab: a search box; results show scored keywords with their sources, ranking videos
  (title, channel, views, age), and suggested tags with a copy button.
- A reusable `Gauge` component (SVG half-dial, 0–100, coloured bands, label + value), used here and by phase 2.
- Not connected → the page explains and links to Settings → Accounts.

## Errors

- Token problems use the existing `getAccessToken` (auth failure → "Reconnect YouTube").
- Missing scope → 403 `insufficientPermissions` → the specific "Reconnect to unlock…" message, other data still shown.
- Quota exceeded (403 `quotaExceeded`) → "YouTube's daily limit is used up; it resets at midnight Pacific".
- Analytics for made-for-kids videos can be partial; missing numbers show as "—".

## Testing

Pure functions get unit tests: response parsers (channel, videos, ISO 8601 durations, analytics rows), keyword
merging/scoring, the quota counter's Pacific day, `scoreSeo` checks, `youtubeText` with tags, scope detection.
API calls use an injected fetch with recorded-shape responses. Routes get the mocked-module tests the other
routes
use.

## Out of scope (phase 2, its own spec)

Story viral planning at the brief, the separate assessor worker that hands the user tasks, and the story
gauges. They will reuse `research`, `scoreSeo`, the channel snapshot and `Gauge`.
