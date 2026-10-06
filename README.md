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

## Picks for a US audience

- **Most replayed.** capy reads YouTube's "Most replayed" graph and tells the picker where viewers rewind; picks that overlap a peak get a badge.
- **A second opinion.** The picker asks for 2 spare candidates, then a separate AI pass reviews every pick (hook in 2 s, self-contained, real payoff, honest hook). Weak hooks are rewritten; weak picks are unticked with the reason on the card. **Replace** on any unrendered card finds a different moment that avoids that problem.
- **Audience: English (US)** (Settings default, per-video override, `--audience` in the CLI). Titles, hooks and upload text are written for American viewers, and when the video isn't in English the burned-in captions are translated phrase by phrase (`words.en.json` next to `words.json`).

## Posting to YouTube, Instagram and TikTok

Free, with your own developer app on each platform (no posting service in between). Set them up under
**Settings → Posting accounts**; the in-app guide (`/settings/posting-setup`) walks through each one.

1. Every rendered clip lands in **Queue → Waiting for your OK**. Watch it, edit the text per platform, untick platforms, then **Approve** (or Reject).
2. Approved clips get the next free slot in the audience's time zone: at most 2 a day per platform, 4 hours apart, the same time on every platform. Move, post now or remove any of them.
3. capy posts at the slot time while it runs. Closing the window with posts scheduled keeps it in the menu bar; slots missed while the computer slept post on wake (up to 2 h late) or move to the next free slot.

What the free tiers allow until you pass each platform's (free) review: YouTube uploads stay **private** (capy links you
to YouTube Studio to flip them public), TikTok clips go to your **TikTok inbox** (you tap Post), Instagram Reels post
publicly but need a Business/Creator account linked to a Facebook Page. Tokens live in `<CAPY_DATA_DIR>/accounts.json`
(mode 0600) and the queue in `queue.json`.

## Automation: watch creators

**Automation** (radar icon in the header) watches YouTube creators. Add one by @handle, channel link or any of their
videos. When they upload, capy runs the whole pipeline on its own: picks, the pick reviewer, footage, English captions,
render. Then an **AI content reviewer** checks every finished clip for platform policy, misleading titles, translation
problems, missing credit and personal data. The clips wait in **Queue → Waiting for your OK** with the AI verdict on
each card; you decide what gets scheduled. Nothing posts on its own.

- New uploads only (adding a channel doesn't backfill; tick "clip their latest upload now" to try it on the newest).
- Skips uploads under 4 minutes and live streams. At most 2 videos per creator and 6 overall per day, one at a time.
- Checks every hour while capy runs (window or menu bar), or on **Check now**. A desktop notification says when new
  clips are waiting. The watch list lives in `<CAPY_DATA_DIR>/watch.json`.

## Stories: original read-aloud picture books for kids

**Stories** (book icon) makes original narrated picture-book Shorts, for free:

1. Create a **series**: name, age group (2–4 or 5–8), tone, values, a look, and 1–6 characters described in words.
   AI draws each character once as vector art; they look the same on every page of every story.
2. Give a **story idea**. AI writes it, a **kid-safety reviewer** checks it (and the writer fixes what it flags once),
   and you edit any page's words, picture or cast before anything is drawn.
3. **Approve the script**: AI draws each page's scene and capy places the characters (2 pages at a time).
4. **Narrate & make the video** with one of this computer's voices: page zooms, crossfades, read-along captions with
   the current word highlighted, the title over the first page.
5. An **AI content reviewer** (kids profile) checks it, AI writes the upload text for parents, and **Send to Queue**
   puts it in Queue → Waiting for your OK. YouTube posts it as made for kids.

Files live in `<output>/stories/<series>/<story>/` (pages as SVG and PNG, narration, the mp4). Install nicer voices in
System Settings → Accessibility → Spoken Content → Manage Voices; they appear in the narrator list.

## Channel and YouTube SEO

**Channel** (sidebar) shows your connected YouTube channel: subscribers and views, four dials (search score of your
videos' text, average % watched, share of views from YouTube search, two-week momentum), daily views for 28 days,
where viewers come from, the exact searches that found you, and every upload with its numbers and search score.

- **Improve** on any video researches what people search for its topic, rewrites the title, description, hashtags and
  tags around the best keyword, and shows both versions with their scores (the rewrite re-scores as you edit).
  **Update on YouTube** changes it there; nothing changes until you click.
- **Keywords** researches any topic: YouTube autocomplete (what people type), what ranks for it (views, tags they
  share) and your own search terms, scored together.
- **Every new upload is tuned too**: clips and stories get keyword research and an SEO rewrite (kept only if it
  scores higher) before the AI content reviewer checks them, and their Queue card shows the score.

Watch time, traffic sources, search terms and editing old videos need two more free Google permissions
(Analytics and `youtube.force-ssl`): reconnect YouTube once in Settings. Ranking searches cost 100 of YouTube's
10,000 free daily API units (an upload costs 1,600), so capy caches them for a week and runs at most 25 a day.
The snapshot lives in `<CAPY_DATA_DIR>/channel.json`, the research cache in `seo-cache.json`.

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
