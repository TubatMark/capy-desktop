# Kids Story Videos Implementation Plan

> Executed inline (superpowers:executing-plans). Spec: `docs/superpowers/specs/2026-10-06-kids-story-videos-plan.md`.

**Goal:** Make original narrated picture-book Shorts (9:16) for kids:
1. series bible with recurring characters
2. AI story writer
3. kid-safety story reviewer
4. editable script
5. illustrated pages
6. narration with read-along captions
7. assembled video
8. AI content review (kids profile)
9. the existing review queue, with YouTube "made for kids" set

**Free by default (the user's no-paid-services rule):**
- **Illustrations:** AI-drawn vector art. Each character is drawn once as an SVG `<g>` sprite. Each page has the AI draw only the background scene; capy places the character sprites itself, so characters stay identical across pages. `rsvg-convert` turns pages into PNG.
- **Narration:** macOS `say`, at a storytelling pace, with any installed voice. Word times are spread over each page's narration by character weight, the same method as `spreadWords` in caption translation.
- **Assembly:** ffmpeg, with a slow zoom per page, crossfades, and the read-along ASS captions from `src/ass.ts`.

**Measured in the spike (2026-10-06):** one character plus one background took about 36 s and looked clean and consistent.

**Out of v1 (stated in the final message):**
- paid image models (Gemini, OpenAI)
- a music bed
- 16:9 episodes
- daily story automation

## Data (`<OUTPUT_ROOT>/stories/<seriesId>/…`)

- `series.json` (`StorySeries`)
- `<storyId>/story.json` (`StoryState`)
- `<storyId>/pages/NN.svg|png`
- `<storyId>/audio/NN.aiff`
- `<storyId>/story.ass`
- `<storyId>/<slug>.mp4` plus a `.jpg` cover

## Tasks

1. **`src/story/svg.ts`** (pure, tested):
   - `sanitizeSvg`: strips script, foreignObject, image, `on*` attributes, external hrefs and style `url()`
   - `charSymbol(id, g)`
   - `castTransform(placement)`
   - `composePage(background, chars, cast)`
2. **`src/story/narrate.ts`:**
   - pure, tested: `parseVoices`, `storyTimeline(pages, gap)`
   - `narrate(text, voice, out)` runs `say` then ffprobe
3. **`src/story/assemble.ts`:**
   - pure, tested: `storyGraph(durations, fade)` builds the filter and offsets
   - `assembleStory()` runs ffmpeg; the read-along style is `storyCaptionStyle()`
4. **`src/story/write.ts`:**
   - schemas, plus pure tested `normalizeStory` and `normalizeStoryReview`, and the prompt builders
   - `writeStory`, `reviseStory`, `reviewStory`, `drawCharacter`, `drawBackground`, `storyPublish`
5. **`src/content-review.ts`:** a `profile: "kids"` option that adds the kid-safety checks (tested).
6. **`lib/types.ts`:** `StorySeries`, `StoryCharacter`, `StoryPage`, `StoryState`; `QueueEntry.madeForKids`.
7. **`server/stories.ts`:** the manager.
   - Store and load of series and stories; a pipeline with deps injected for tests.
   - Steps: create series (draws characters) → write story (writer, then reviewer, then one automatic revision on "fix") → approve script → illustrate (2 at a time) → narrate and render → content review → `sendToQueue`.
   - Harness tests with fakes.
8. **Queue and poster:**
   - `upsertForRender` takes `madeForKids`.
   - The poster's `fileFor` resolves `story-*` entries through the stories manager, checking the fingerprint of start 0 and end = duration.
   - The YouTube client sets `selfDeclaredMadeForKids` from `PostJob.madeForKids`.
   - Tested.
9. **Routes:** under `/api/stories/**` (series, stories, actions). Tested with zod and 404/409 cases.
10. **UI:**
    - "Stories" in the sidebar
    - `/stories` (series list, new series)
    - `/stories/[seriesId]` (characters, new story, story list)
    - `/stories/[seriesId]/[storyId]` (script, then pages, then voice and render, then video, AI review and Send to Queue)
11. **End-to-end:** a real series and story in the preview; look at the frames.
12. **Final review** by a fresh reviewer, a fix pass, and merge.
