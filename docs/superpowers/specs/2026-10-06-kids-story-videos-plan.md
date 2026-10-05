# Original kids story videos — plan (not built yet)

Date: 2026-10-06 · Status: plan only, as the user asked. Nothing here is implemented.

## Goal

Alongside clipping, capy makes **its own** content: short narrated picture-book videos for children, with original
stories, illustrations, narration and read-along captions. Each video goes through the same AI review, user review,
queue and posting flow as clips.

## What one video is

- **Format:**
  - **Story Short:** 9:16, 45–90 s, one tiny story with one idea, about 8 pages.
  - **Storybook episode:** 16:9 for YouTube, 3–6 min, 12–20 pages, an intro bumper and an end card.
- **Look:**
  - one illustrated page per beat, with a slow Ken Burns pan and zoom and soft page-turn transitions
  - **read-along captions** with the current word highlighted, reusing capy's ASS caption renderer: the words come
    from TTS timings instead of YouTube captions
- **Sound:** a warm narrator voice (TTS), gentle royalty-free music under it ducked to the voice, and light sound
  effects (page turn, chime).
- **Age bands:** 2–4 (very simple, repetition) and 5–8 (a small problem solved, gentle humour). Picked per series.

## Pipeline (each step writes files, so any step can be re-run or edited)

1. **Series bible (once per series):**
   - title, age band, tone, art style prompt
   - 2–4 recurring characters, each with a **character sheet**: a fixed description and a reference image used in
     every illustration to keep characters consistent
   - values (kindness, sharing, bedtime routines…)
   - Stored in `<output>/stories/<series>/series.json` plus the reference images.
2. **Story idea → script** (AI): a brief ("Pip the penguin learns to share his sled") becomes JSON:
   `{ title, moral, pages: [{ text, scene, characters, mood }] }`. Constraints:
   - reading level for the age band
   - at most 25 words per page
   - no scary, violent or unsafe imitation content
   - a calm ending for bedtime stories
3. **Story reviewer (AI, before any media is made):**
   - kid-safety checklist: no dangerous acts a child could copy, no stereotypes, no brand names, no scary imagery
     for 2–4
   - checks it is original and not a retelling of a copyrighted story
   - checks age-appropriate words
   - Verdict plus fixes, then the user approves the script in the app (the same review card pattern).
4. **Illustrations:** one image per page from an image model, using the series art-style prompt plus each character's
   sheet and reference image.
   - Providers, behind one interface:
     - Google Gemini image models: good character consistency with reference images, low cost
     - OpenAI image models
     - fal.ai / Replicate (Flux with a character LoRA)
   - Default to the cheapest that keeps characters consistent; the user picks it in Settings.
   - An **image reviewer** (vision AI) checks each page: right characters, no extra limbs or garbled text, nothing
     scary. It regenerates a failed page up to 2 times.
5. **Narration:**
   - TTS with word timestamps. Options:
     - ElevenLabs: best voices, gives timestamps, paid
     - OpenAI TTS: cheap
     - local Kokoro or Piper: free and offline
   - Timestamps drive the read-along highlight. Without them, run local Whisper (already supported) on the
     narration to get word times.
6. **Assembly** with ffmpeg (already in capy): per-page clips (Ken Burns on the image, timed to its narration line),
   crossfades, the read-along ASS captions, a music bed with sidechain ducking, and an intro and outro. The same
   1080×1920 / 1920×1080 encoders capy already uses.
7. **Final AI content reviewer:** the same reviewer as clips, with a kids profile (kid safety plus platform
   made-for-kids rules), then the user review in Queue.
8. **Posting through the existing queue**, with made-for-kids handling:
   - **YouTube:** `status.selfDeclaredMadeForKids = true`. Comments and personalized ads are off for these videos;
     the Queue card says so.
   - **TikTok and Instagram:** both require users to be 13+, so posts there are aimed at parents ("bedtime story for
     your little one"), and captions are written for parents, never addressed to children.

## App changes

- A new **Create** page next to the library:
  - Series list → series bible editor
  - a "New story" brief box
  - a step view: script (editable) → pages grid (regenerate any page) → narration (listen, change voice) → render
    preview
- **Settings → Creative providers:** image model and key, TTS voice and key, or the free local options.
- Data model: `StoryJob` alongside `JobState`, with its own `<output>/stories/<series>/<story>/` folder holding
  `story.json`, `pages/*.png`, `narration.wav`, `words.json` and the final mp4s. The queue entry points at the story
  instead of a clip (`source: "story"`).

## Risks and policy

- **YouTube's "inauthentic / mass-produced content" rule (July 2025) and the made-for-kids rules (COPPA):** monetized
  channels need real creative input.
  - Mitigation: the series bible, edited scripts, user review, and a consistent original cast. Don't pump out
    near-identical videos.
  - The plan caps output at 1 story per day per series by default.
- **Character consistency** is the main quality risk. It's mitigated by reference images, the image reviewer, and
  regenerating pages.
- **Cost per video:** roughly 8–20 images plus 1 TTS pass plus about 4 AI calls.
  - With mid-tier image models, a cent-level to low-dollar range per video.
  - Fully free path: local TTS and a local image model, slower and lower quality.
  - The app shows the estimate before generating.
- **No real children's voices or likenesses**, and no copyrighted characters or stories.

## Milestones (each one is shippable)

1. **Script only:** series bible, story writer, story reviewer, script editor, and a plain text-on-color video with TTS
   and read-along captions (no images). Proves the narration and caption path.
2. **Illustrated pages:** image provider interface, character sheets, image reviewer, page grid, and Ken Burns assembly.
3. **Polish and posting:** music and ducking, intro and outro, 16:9 episodes, the made-for-kids posting flags, kids
   profile for the content reviewer.
4. **Automation:** "make one story per day from the series backlog" and land it in Queue for review, reusing the
   creator-automation loop.

## Open questions (decided by default for now)

- Language: English (US) first, matching the audience setting.
- Platforms: YouTube first, with TikTok and Instagram posts written for parents.
- Default provider: Gemini image plus local Kokoro TTS for a near-free start, with ElevenLabs as the quality upgrade.
