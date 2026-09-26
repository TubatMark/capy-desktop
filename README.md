<p align="center"><img src="public/capy-logo.png" width="240" alt="capy"></p>

# capy

YouTube URL → captioned 9:16 shorts. Claude picks the moments; everything else runs on your Mac.

```
YouTube URL ─▶ yt-dlp captions ─▶ Claude picks clips ─▶ yt-dlp downloads only those
             (seconds, no Whisper)  (Agent SDK, your      sections ─▶ ffmpeg crops to 9:16,
                                     Claude login)         burns word-by-word captions + hook
```

This repo is the desktop build of capy: the same pipeline and web UI, wrapped in an Electron
shell so you can double-click `capy.app`, paste a link and get clips with no terminal and no
`.env`. The web app still runs in a plain browser (`pnpm dev`) and the CLI still works.

## Setup (once)

```bash
brew install ffmpeg-full yt-dlp   # ffmpeg-full has libass for captions; capy finds it automatically
pnpm install
claude            # log in once if you haven't; the picker bills your Claude subscription
pnpm check        # checks ffmpeg/libass, yt-dlp, encoder, a test caption render, and a live Claude round-trip
```

Optional, only for videos with no captions at all: `pip install mlx-whisper` (Apple-silicon GPU transcription).

The same checks are available in the app under **Settings → Setup check**, with the fix for
each failure ready to copy.

## The desktop app

```bash
pnpm desktop:dev      # Electron window + `next dev` with hot reload
pnpm desktop:pack     # unsigned app bundle in dist/ for a quick smoke test (no .dmg)
pnpm desktop:build    # production build + .dmg (Apple silicon, unsigned)
```

The app spawns the Next.js server on a free localhost port and opens one window; **⌘,** opens
Settings and **Open Output Folder** in the menu reveals your clips in Finder. Finder-launched
apps get a minimal `PATH`, so capy adds `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`
and `~/Library/Python/*/bin` itself before looking for `yt-dlp`, `ffmpeg` and `mlx_whisper`.

In the app, clips land in **`~/Movies/capy`** by default (the browser workflow keeps `./output`).
Change it under Settings → Output folder; the change applies the next time you open the app.

## The app in a browser

```bash
pnpm dev          # then open http://localhost:3000
```

1. **Paste a link.** A stepper shows each stage with a countdown (video info → transcript → Claude picks → downloading clips). Estimates learn from your machine after the first run.
2. **Review picks.** Each pick is a phone-shaped card with thumbnail, hook, title, score and length. Tick the ones you want and hit **Render selected**, or click a card to edit it.
3. **Edit a clip.** Each clip also gets a **Publish to YouTube** panel (title, description, hashtags, thumbnail; copy buttons) and a **Best time to post** panel (next slots in UTC, audience time and your time; audience is a dropdown).
    The editor shows a 9:16 preview with live captions and hook, the transcript (click a word to move the playhead; `I`/`O` set in/out), a trim timeline, and the YouTube player at that moment. Save, snap to speech, render, download, or **Show in Finder**.
4. **Files** land in `<output>/<title>-<id>/` next to `job.json`, `clips.json` and `words.json`.

Each pick downloads a padded segment (±15 s) so trimming in the editor doesn't re-download; going past the padding fetches a new segment automatically.

## Settings

Open **Settings** in the header (or **⌘,** in the app). Everything you set there is stored in one
file and wins over `.env` and shell variables:

| Setting | What it does | Env equivalent |
|---|---|---|
| Browser cookies | yt-dlp uses that browser's YouTube login (fixes 429 / "confirm you're not a bot") | `CAPY_BROWSER` |
| Output folder | Where jobs and rendered clips go. Applies after relaunch | `CAPY_OUTPUT` |
| Model | Default picker model; each video can override it | `CAPY_MODEL` |
| Billing | **Claude subscription** (the `claude` login on this Mac) or **API key** | `CAPY_USE_API_KEY=1` + `ANTHROPIC_API_KEY` |
| API key | Used only in API-key mode | `ANTHROPIC_API_KEY` |

Where it lives: `<CAPY_DATA_DIR>/settings.json`, and `CAPY_DATA_DIR` defaults to
`~/Library/Application Support/capy` (the Electron shell passes its own user-data folder,
which is the same path). The file is written with mode `0600` because it can hold the API key;
`GET /api/settings` always returns the key redacted to its last four characters.

Precedence, lowest to highest: built-in default → environment (`CAPY_*`, from your shell or
`.env`) → `settings.json` → the per-video settings you pick in the URL form. `server/settings.ts`
is the only module that reads or writes the file; see `.env.example` for the variables.

The **Setup check** panel on the same page streams `GET /api/check`: yt-dlp, ffmpeg, a real
caption render (catches an ffmpeg without libass), the encoder, an optional Whisper, and a live
Claude round-trip. Each failure comes with the command that fixes it.

## The CLI

Same pipeline, no browser. It reads the same `settings.json` (flags win):

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
| `--model` | Settings / `CAPY_MODEL` / Sonnet | e.g. `claude-haiku-4-5-20251001` for cheaper picks |
| `--proxy`, `--cookies` | | for yt-dlp; cookies fix "confirm you're not a bot" |
| `--jobs` | 2 | parallel download+render |
| `--whisper` | | force local transcription |

## How the Claude call works

`src/pick.ts` uses `@anthropic-ai/claude-agent-sdk` with `tools: []`, a JSON schema output format, and `persistSession: false`. It sends only the transcript text (never video) and gets back `{clips:[{start,end,title,hook,reason,score}]}`. By default auth comes from your `claude` login on this machine, so usage counts against your subscription, not an API key (an `ANTHROPIC_API_KEY` in your shell is deliberately ignored; switch Settings → Billing to **API key**, or set `CAPY_USE_API_KEY=1`, to use one). Keep subscription mode for personal use: routing other people's requests through a subscription is against Anthropic's terms.

## Dev

```bash
pnpm test         # unit tests (parsers, snapping, ASS builder, render helpers, settings, doctor, access, PATH)
pnpm typecheck
pnpm build        # production build of the web app
```

Layout:

- `src/` — the pipeline (yt-dlp, captions, Claude picker, ASS subtitles, ffmpeg). Shared by the CLI and the app.
- `server/` — job manager (stages, time estimates, persistence to `<output>/*/job.json`), media paths, `settings.ts`, `doctor.ts` (setup check), `access.ts` (who may do what), `boot.ts` (one-time start-up: `.env`, PATH, billing env).
- `app/api/` — HTTP + SSE endpoints the UI talks to. `app/`, `components/` — the Next.js UI.
- `electron/` — the desktop shell (main process, server launcher, free-port picker), bundled to `dist-electron/`.
- `lib/types.ts` — the one shared type file (no node imports) so the browser and server agree.

## Sharing this app later

Today capy is built for one person on one Mac, but the seams for accounts and a paid plan are
already in place. To share it:

1. **Sign-in.** Replace `server/access.ts`. `getAccess(req)` is the single function that decides
   who the user is and what they may do (`Access` in `lib/types.ts`: `user`, `plan`,
   `can.createJob`, `can.render`). Read a session cookie there, look up the plan, and fill `can`.
   `POST /api/jobs` and `POST /api/jobs/[id]/render` already answer
   `403 { error: "Sign in required", code: "forbidden" }` when a capability is false, and
   `GET /api/me` returns the `Access` object. In the UI, `hooks/use-access.ts` fetches it and
   `<AccessGate action="createJob" | "render">` (`components/access-gate.tsx`) already wraps the
   URL form and the Render button, so they turn into a "Sign in required" placeholder on their own.
   Add a sign-in route/page and a paywall that flips `can.*` by plan; nothing else needs to change.
2. **Billing.** Switch users to `claudeAuth: "apiKey"` (Settings → Billing, or make it the default
   and hide the subscription option). Routing other people's requests through your Claude
   subscription violates Anthropic's terms; an API key is billed per call and can be yours
   (server-side) or theirs.
3. **Signing.** Sign and notarize the app (`electron-builder` `identity` + notarize config) so
   Gatekeeper opens it without the right-click dance, and enable auto-update if you want.
4. **Bundle the tools.** Ship `ffmpeg-full` (with libass) and `yt-dlp` inside the app instead
   of expecting Homebrew; point `CAPY_FFMPEG_DIR` at the bundled ffmpeg and prepend the bundle's
   `bin` in `ensureToolPaths()` (`src/exec.ts`).
5. **Move state off the machine** if it becomes a service: jobs live in `<output>/*/job.json`
   and settings in `settings.json`; both go through one module each (`server/jobs.ts`,
   `server/settings.ts`).

## Roadmap

1. ~~CLI pipeline~~
2. ~~Local web app: paste URL, review/adjust picks, render, preview~~
3. ~~Desktop app (Electron), settings, setup check~~
4. Face-tracked cropping, more caption styles, manual clip creation from the video page
5. Sign-in + plans (see above)
