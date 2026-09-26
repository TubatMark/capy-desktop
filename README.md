<p align="center"><img src="public/capy-logo.png" width="240" alt="capy"></p>

# capy

YouTube URL → captioned 9:16 shorts. Claude picks the moments; everything else runs on your Mac.

```
YouTube URL ─▶ yt-dlp captions ─▶ Claude picks clips ─▶ yt-dlp downloads only those
             (seconds, no Whisper)  (Agent SDK, your      sections ─▶ ffmpeg crops to 9:16,
                                     Claude login)         burns word-by-word captions + hook
```

## Setup (once)

```bash
brew install ffmpeg-full yt-dlp   # ffmpeg-full has libass for captions; capy finds it automatically
pnpm install
claude            # log in once if you haven't; the picker bills your Claude subscription
pnpm check        # checks ffmpeg/libass, yt-dlp, encoder, a test caption render, and a live Claude round-trip
```

Optional, only for videos with no captions at all: `pip install mlx-whisper` (Apple-silicon GPU transcription).

## The app

```bash
pnpm dev          # then open http://localhost:3000
```

1. **Paste a link.** A stepper shows each stage with a countdown (video info → transcript → Claude picks → downloading clips). Estimates learn from your machine after the first run.
2. **Review picks.** Each pick is a phone-shaped card with thumbnail, hook, title, score and length. Tick the ones you want and hit **Render selected**, or click a card to edit it.
3. **Edit a clip.** Each clip also gets a **Publish to YouTube** panel (title, description, hashtags, thumbnail; copy buttons) and a **Best time to post** panel (next slots in UTC, audience time and your time; audience is a dropdown).
    The editor shows a 9:16 preview with live captions and hook, the transcript (click a word to move the playhead; `I`/`O` set in/out), a trim timeline, and the YouTube player at that moment. Save, snap to speech, render, download.
4. **Files** land in `output/<title>-<id>/` next to `job.json`, `clips.json` and `words.json`.

Cookies: set `CAPY_BROWSER=chrome` in your shell (or `.env`) so yt-dlp uses your browser's YouTube login (fixes 429 / bot checks). The app reads it on startup.

Each pick downloads a padded segment (±15 s) so trimming in the editor doesn't re-download; going past the padding fetches a new segment automatically.

## The CLI

Same pipeline, no browser:

```bash
pnpm clip "https://youtu.be/VIDEO_ID" --browser chrome
pnpm clip "https://youtu.be/VIDEO_ID" -n 8 --min 25 --max 55 --focus "every joke that landed"
pnpm clip "https://youtu.be/VIDEO_ID" --pick-only        # review picks first
pnpm clip "https://youtu.be/VIDEO_ID" --layout blur --style clean
```

## Flags

| Flag | Default | Notes |
|---|---|---|
| `-n, --count` | 6 | clips to ask for |
| `--min` / `--max` | 20 / 60 | clip length bounds, seconds |
| `--focus "…"` | | steer the picker |
| `--layout` | center | `center` crops the middle; `blur` fits the full frame over a blurred copy |
| `--style` | bold | `bold` (uppercase, yellow highlight) or `clean` |
| `--no-captions`, `--no-hook` | | |
| `--lang` | video language, then `en` | caption track to prefer |
| `--model` | your Claude Code default | e.g. `claude-sonnet-5` for cheaper picks |
| `--proxy`, `--cookies` | | for yt-dlp; cookies fix "confirm you're not a bot" |
| `--jobs` | 2 | parallel download+render |
| `--whisper` | | force local transcription |

## How the Claude call works

`src/pick.ts` uses `@anthropic-ai/claude-agent-sdk` with `tools: []`, a JSON schema output format, and `persistSession: false`. It sends only the transcript text (never video) and gets back `{clips:[{start,end,title,hook,reason,score}]}`. Auth comes from your `claude` login on this machine, so usage counts against your subscription, not an API key. Keep this for personal use: routing other people's requests through a subscription is against Anthropic's terms.

## Dev

```bash
pnpm test         # unit tests (parsers, snapping, ASS builder, render helpers)
pnpm typecheck
pnpm build        # production build of the app
```

Layout:

- `src/` — the pipeline (yt-dlp, captions, Claude picker, ASS subtitles, ffmpeg). Shared by the CLI and the app.
- `server/` — job manager (stages, time estimates, persistence to `output/*/job.json`), media paths.
- `app/api/` — HTTP + SSE endpoints the UI talks to. `app/`, `components/` — the Next.js UI.
- `lib/types.ts` — the one shared type file (no node imports) so the browser and server agree.

### Desktop later

The UI only talks to `/api/*` on localhost and all state lives in `output/`, so a desktop build is a wrapper, not a rewrite: Tauri (or Electron) starts `next start` as a sidecar and opens a window at `http://localhost:3000`. Nothing in `components/` needs to change. Bundling ffmpeg-full and yt-dlp with the app is the only extra step.

## How the Claude call works

`src/pick.ts` uses `@anthropic-ai/claude-agent-sdk` with `tools: []`, a JSON schema output format, and `persistSession: false`. It sends only the transcript text (never video) and gets back `{clips:[{start,end,title,hook,reason,score}]}`. Auth comes from your `claude` login on this machine, so usage counts against your subscription, not an API key (an `ANTHROPIC_API_KEY` in your shell is deliberately ignored; set `CAPY_USE_API_KEY=1` to use it). Keep this for personal use: routing other people's requests through a subscription is against Anthropic's terms.

## Roadmap

1. ~~CLI pipeline~~
2. ~~Local web app: paste URL, review/adjust picks, render, preview~~
3. Face-tracked cropping, more caption styles, manual clip creation from the video page
4. Server-side caption fetch + picking via Proxyrack for queued/high-volume runs
5. Desktop wrapper (Tauri)
