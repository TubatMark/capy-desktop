# Better picks and US reach — design

Date: 2026-10-05 · Status: approved in chat, awaiting spec review

Part A of two. Part B (posting to YouTube, Instagram and TikTok, with a scheduler that spreads clips over
different slots) gets its own spec.

## Goal

Pick better moments and make clips work for a US audience, including videos whose speakers aren't English.
Success means three things. Picks overlap the parts viewers actually replay. A Portuguese video can come out
as English-captioned Shorts with English hooks and upload text. Weak picks are caught before the user spends
render time on them, and each one can be replaced in one click.

What the user said: source videos are a mix of English and non-English. Translated clips get English captions
synced phrase by phrase. A failing pick is fixed or flagged, never silently dropped, and gets a button to find
a replacement that's aimed at the specific failure.

## A1. "Most replayed" signal

- `VideoMeta` gains `heatmap?: { start: number; end: number; value: number }[]`, filled by `fetchMeta`
  (`src/youtube.ts`) from yt-dlp's `heatmap` field (`start_time`, `end_time`, `value` 0..1). It's absent when
  YouTube has no data.
- A new pure helper, `replayPeaks(heatmap, { minValue = 0.5, max = 8 })` in `src/heatmap.ts`, returns merged
  ranges `{ start, end, value }` sorted by value. Adjacent heatmap buckets at or above `minValue` merge into one
  range.
- `buildPrompt` (`src/pick.ts`) adds a "Viewer replay peaks" section when peaks exist, one line per peak:
  `12:40–13:10 (100%)`. Rule text: *"These are the parts viewers rewound to most: a strong signal of a great
  moment. Prefer clips that contain a peak, but each clip must still be self-contained."*
- `ClipState` gains `replayPeak?: number`, the highest overlapping peak value. It's set in the job manager after
  picking. The pick card shows a **"Most replayed"** badge when it's 0.7 or above.

## A2. Target audience: English (US)

### Setting
- `JobSettings.audience: "original" | "en-us"`. `AppSettings.audience` holds the default, which is `"en-us"`. It
  can be set in Settings and overridden per video in the URL form. The CLI gets `--audience original|en-us`.
- **Source language** is `meta.language`, falling back to the caption track language that `pickCaptionLang`
  chose, then to the Whisper language. `needsTranslation = audience === "en-us" && !isEnglish(sourceLang)`. An
  unknown language counts as English, so nothing is translated.

### Picker and text tuning (whenever audience is en-us)
- `buildPrompt`, `rewriteTitleHook` and `generatePublish` replace "same language as the speakers" with:
  *"Write title, hook, ytTitle, description and hashtags in natural US English for American viewers. Avoid
  moments that only work with local cultural context the hook can't explain. Prefer hashtags US viewers search
  for."* The "Credit:" line stays.
- With audience `original`, the prompts stay as they are today.

### Caption translation (only when needsTranslation)
- New `src/translate.ts`:
  - `splitPhrases(words, start, end)` is pure. It cuts at sentence punctuation, at gaps over 0.6 s, or at 4 s.
    It returns `{ i, start, end, text }`.
  - `translatePhrases(phrases, sourceLang, agent, model)` makes one AI call with the JSON schema
    `{ phrases: [{ i, en }] }`. It's told to translate 1:1, keep it short and spoken, and use US English. It
    retries once when an index is missing, then falls back to the original text for that phrase.
  - `spreadWords(phrase, en)` is pure. It splits `en` into words and gives each a slice of
    `[phrase.start, phrase.end]` proportional to its character length (minimum 0.12 s). It returns `Word[]` in
    source-video time.
- **What gets translated:** the clip's padded segment range (`segmentFor`, ±15 s), so trimming inside the
  padding needs no new call. Results merge into `<jobDir>/words.en.json`, a `Word[]` covering every translated
  range, plus `translated: {start,end}[]` in the job state. When a new segment is fetched past the padding, the
  uncovered part gets translated.
- **When:** in the job manager, after picking (and after replace), for every clip, alongside the segment
  download. The stage stays "segments", so no new stage enters the estimates.
- **Render:** `stageRender` takes the caption words. The job manager passes `wordsInRange(enWords, …)` when the
  clip is translated, otherwise the original words. The ASS builder doesn't change.
- **Editor:** `GET /api/jobs/[id]/words` also returns `captionWords` when translated. The transcript panel keeps
  the original words, so click-to-seek and I/O still match the audio. `CaptionOverlay` gets `captionWords`.

## A3. Separate reviewer and per-clip replace

### Reviewer
- The picker asks for `count + 2` candidates.
- New `src/review.ts` exports `reviewPicks(words, meta, clips, { audience, agent, model })`. It's one fresh AI
  call (no picker context, its own system prompt, effort `medium`). It gets each clip's transcript excerpt plus
  its title, hook and reason. Schema per clip:
  `{ n, verdict: "pass" | "fix_hook" | "fail", problem?: string, title?: string, hook?: string }`.
  The checks:
  1. Does it hook in the first 2 s?
  2. Does it make sense on its own with zero context?
  3. Does it end on a payoff or complete thought?
  4. Is the hook honest about what actually happens?
  5. With audience en-us: will a US viewer get it?
- `applyReview(clips, review, count)` is pure.
  - **fix_hook**: take the reviewer's title and hook (only when both are non-empty), and set `review = { verdict, problem }`.
  - **fail**: set `selected = false` and `review = { verdict: "fail", problem }`.
  - **Ticking**: tick the passing and fixed clips with the best scores, up to `count`. Everything else stays in
    the list, unticked.
- `ClipState.review?: { verdict: "pass" | "fix_hook" | "fail"; problem?: string }`.
- If the review call fails, log it and keep the picks unreviewed, ticking the top `count` by score as today.
  Picking never fails because of the reviewer.
- The pick card shows a red note `Reviewer: <problem>` for fail, and a muted note `Hook rewritten` for fix_hook.

### Replace one clip
- Every pick card that isn't rendered gets a **Replace** button. It opens a small popover with a reason field,
  prefilled with `review.problem` when there is one and editable, plus a Replace button.
- New `POST /api/jobs/[id]/clips/[n]/replace` with body `{ reason?: string }` calls `jobs().replaceClip(id, n, reason)`:
  1. Calls `pickClips` with `count: 1` and an extra prompt section: *"Find a different moment. The previous pick
     at mm:ss–mm:ss was rejected because: <reason>. Avoid that problem. Do not overlap these ranges: …"* (every
     other clip's range, plus the rejected one).
  2. Reviews the new clip, keeping a fix_hook result.
  3. Replaces clip `n` in place, keeping `n` and `selected = true` (unless the review fails, in which case it
     shows the note), clears render, thumbs and publish, then downloads the segment and translates it if needed.
  4. Returns 409 while the clip is rendering or rendered, and 400 when the picker finds nothing new.
- The button shows a spinner and the card shows the segment progress, the same as after a repick.

## Error handling

- No heatmap: no section, no badge.
- Translation call fails: the clip keeps the original captions and its card says "Captions not translated",
  with a Retry action (`POST /api/jobs/[id]/clips/[n]/translate`, which runs only the translate step for that
  clip's segment range).
- Reviewer fails: picks stay unreviewed (see above).
- Replace fails: the clip is unchanged and the card shows the error.

## Testing

Vitest unit tests:
- `replayPeaks`: merging, threshold, empty input
- `splitPhrases`: punctuation, gaps, 4 s cap
- `spreadWords`: spans stay inside the phrase, ordered, minimum duration
- `applyReview`: verdict handling, ticking up to count, empty title/hook ignored
- `buildPrompt`: includes the replay-peaks, en-us and replace sections only when they apply
- `isEnglish`: `en`, `en-US`, `en-orig`

Then one manual end-to-end run in the app on an English video and on a non-English video. Check the badge, the
reviewer notes, Replace, and an English-captioned render.

## Out of scope

Dubbing or voice translation, more audiences than original and en-us, and audio-peak or laughter detection.
Posting and scheduling belong to part B.
