# capy-desktop — design

Date: 2026-09-27. Status: approved in conversation; implementation follows the plan in `docs/superpowers/plans/`.

## Intent

Ship `capy` (YouTube URL → captioned 9:16 shorts) as a native macOS app for one person's Mac,
built so that adding sign-in and a paid subscription later is a matter of replacing one module
and adding a sign-in screen — not a rewrite.

What the user said:
- Just me, on my Mac. Electron is fine.
- Later we may share it: be ready for a login and possibly a paywall/subscription.
- Separate folder under `m4rk/`, based on this project.
- Responsive to all screen sizes.

Assumptions I'm making (correct me):
- Apple-silicon only, unsigned `.dmg`, no notarization, no auto-update.
- Homebrew `ffmpeg-full` and `yt-dlp` stay system-installed (not bundled); the app finds them
  and tells you the `brew` command when they're missing.
- Claude billing keeps using the local `claude` login by default; API-key mode is a setting.

Success looks like: double-click `capy.app`, paste a link, review picks, render, open the clip
folder in Finder — with no terminal, no `.env`, and a layout that works from a 400 px window to
a 4K monitor.

## 1. Repository

- New repo at `m4rk/capy-desktop/`, cloned from `capy@main` (d8c7d06), origin removed. It is a
  fork: fixes in `capy` do not flow here automatically.
- Pipeline (`src/`), job manager (`server/`), CLI and tests come over unchanged except where
  sections 3–5 say otherwise. The web app keeps working in a plain browser (`pnpm dev`).

## 2. Electron shell

Files live in `electron/` and are bundled with esbuild to `dist-electron/` (CommonJS). Electron
44, electron-builder 26.

### Main process (`electron/main.ts`)
- Single-instance lock; a second launch focuses the existing window.
- One `BrowserWindow`: `titleBarStyle: "hiddenInset"`, min size 400×600, size/position persisted
  to `<userData>/window.json` and restored on launch. `contextIsolation: true`,
  `nodeIntegration: false`, no preload (the UI needs nothing from Electron; see §2.4).
- Loads `http://127.0.0.1:<port>` once the server answers `GET /api/jobs` with 200.
- `setWindowOpenHandler` and `will-navigate`: any URL not on our origin opens in the default
  browser via `shell.openExternal`.
- Downloads: Electron's default save dialog (no code needed; verified in testing).
- macOS menu via `Menu.buildFromTemplate`: app/edit/view/window roles plus
  **Settings… (⌘,)** → navigates the window to `/settings`, **Open Output Folder** →
  `shell.openPath(outputDir)`.
- On `before-quit`, kill the server child process (SIGTERM, then SIGKILL after 3 s).

### Server (`electron/server.ts`)
- Production: `next build` with `output: "standalone"`; `public/` and `.next/static` copied into
  `.next/standalone/` by the build script; the whole folder ships as
  `Contents/Resources/server/`. Main spawns
  `process.execPath server/server.js` with env
  `ELECTRON_RUN_AS_NODE=1, NODE_ENV=production, HOSTNAME=127.0.0.1, PORT=<free port>,
  CAPY_DESKTOP=1, CAPY_DATA_DIR=<userData>, PATH=<fixed, §3.1>`.
  `ELECTRON_RUN_AS_NODE` is inherited by everything the server spawns, so the Claude Agent SDK's
  `process.execPath` launches run as Node, not as another Electron app.
- Development (`pnpm desktop:dev`): main spawns `next dev -p <free port>` from the project root
  with the same env (minus `NODE_ENV`) and waits for the port. HMR works as usual.
- Free port: `electron/port.ts` `pickPort()` binds `127.0.0.1:0` and returns the assigned port.
- If the server exits before it is ready, or does not answer within 30 s, show a native error
  dialog with the last 30 lines of its stderr and quit.

### Packaging
- `electron-builder`: `appId com.m4rk.capy`, `productName capy`, target `dmg` for `arm64`,
  `asar: true` for the shell, `extraResources: [{ from: ".next/standalone", to: "server" }]`,
  `identity: null` (unsigned). Icon: `build/icon.png` (1024², generated from
  `public/capy-mark.png` with `sips`).
- Scripts: `desktop:dev`, `desktop:build` (next build → copy static/public → esbuild → builder),
  `desktop:pack` (same but `--dir`, for quick smoke tests).

### 2.4 Desktop affordances that live in the web app
Both work in the browser too, so no Electron bridge is needed:
- **Show in Finder**: `POST /api/jobs/[id]/reveal` runs `open -R <job dir>` (macOS). The video
  page gets a button next to Download.
- **Title bar**: `app/layout.tsx` sets `data-desktop` on `<html>` when `CAPY_DESKTOP=1`;
  `globals.css` then gives the header 80 px left padding (traffic lights) and
  `-webkit-app-region: drag`, with `no-drag` on links and buttons.

## 3. Running as an app, not a terminal process

### 3.1 PATH
Finder-launched apps get a minimal PATH. `src/exec.ts` gains `ensureToolPaths()` (called once at
module load, idempotent, unit-tested) that prepends, if missing: `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.local/bin`, `~/Library/Python/*/bin`. `resolveBin` keeps its
`ffmpeg-full` lookup. The Electron main also passes this PATH explicitly.

### 3.2 Settings (`server/settings.ts`)
- File: `<CAPY_DATA_DIR>/settings.json`. `CAPY_DATA_DIR` defaults to
  `~/Library/Application Support/capy-desktop` (Electron passes `app.getPath("userData")`,
  which is the same path).
- Shape (`lib/types.ts` → `AppSettings`):
  `{ browser?: string; outputDir?: string; model?: string;
     claudeAuth: "subscription" | "apiKey"; apiKey?: string; checkedAt?: number }`.
- Precedence, lowest to highest: built-in default → environment variable (`CAPY_*`, `.env`)
  → `settings.json` → per-job settings. `.env` is still loaded (via `loadDotEnv`) at server
  start so the browser workflow is unchanged.
- `server/paths.ts`: `OUTPUT_ROOT` = settings.outputDir → `CAPY_OUTPUT` →
  (`CAPY_DESKTOP` ? `~/Movies/capy` : `./output`). Resolved once at startup; the Settings page
  says a change to the output folder applies after relaunch.
- `claudeAuth`: `"subscription"` (default) keeps today's behaviour (drop `ANTHROPIC_API_KEY`
  from the SDK subprocess). `"apiKey"` sets `CAPY_USE_API_KEY=1` and `ANTHROPIC_API_KEY` from
  `settings.apiKey` before the SDK call. The key is stored in `settings.json` (mode 0600).
- API: `GET /api/settings` (key redacted to `"••••"` + last 4), `PUT /api/settings` (partial
  merge; empty string clears a field). `server/settings.ts` is the only reader/writer.
- UI: `app/settings/page.tsx` with `components/settings-form.tsx`: browser (select: none /
  chrome / safari / firefox / brave / edge / arc), output folder (text), model (select from
  `lib/types.ts` `MODELS`), Claude billing (radio) + API key (password input), and the
  setup-check panel (§4). Header gets a **Settings** link.

## 4. Setup check
- `server/doctor.ts` exports `runChecks(): AsyncGenerator<CheckResult>` where
  `CheckResult = { name, ok, detail, fix? }`, extracted from `src/cli.ts doctor()` (which now
  consumes it — same output). `fix` is a copy-pasteable command or a sentence
  (`brew install ffmpeg-full yt-dlp`, `run \`claude\` in a terminal and log in`).
- `GET /api/check`: SSE, one event per check, then `done`. Writes `checkedAt` to settings on
  completion.
- `components/setup-check.tsx`: list with ✓/✗, detail, and the fix in a `<code>` block with a
  copy button. Home page shows a dismissible "Run the setup check" banner while
  `checkedAt` is unset.

## 5. Access seam (login + paywall later)
- `server/access.ts`: `getAccess(): Promise<Access>`; today returns
  `{ user: { id: "local", name: "Local owner" }, plan: "local", can: { createJob: true, render: true } }`.
  `Access` is in `lib/types.ts`. This is the only place that will change to add auth.
- Enforced in `POST /api/jobs` and `POST /api/jobs/[id]/render`: `403 { error, code: "forbidden" }`
  when the capability is false. `GET /api/me` returns `Access`.
- UI: `hooks/use-access.ts` (fetches `/api/me`, cached per page) and
  `components/access-gate.tsx` — `<AccessGate action="createJob" | "render">` renders children
  when allowed, otherwise a disabled control with a "Sign in required" hint. Wraps the URL
  form submit and the Render button.
- README gets a "Sharing this app later" section: replace `server/access.ts`, add a sign-in
  route, switch users to `claudeAuth: "apiKey"` (subscription routing for others violates
  Anthropic's terms), sign + notarize, bundle ffmpeg/yt-dlp.

## 6. Responsive layout
Target: 360 px → 2560 px wide, and a 400×600 window minimum. Every screen is reworked:
- **Header**: at `< sm` the nav text collapses to icons with `aria-label`s; wordmark stays.
- **Home**: hero logo scales (`h-28 sm:h-44`), URL form stacks its input and button at `< sm`;
  library grid `1 / 2 / 3 / 4 / 5` columns at `base / sm / lg / xl / 2xl`.
- **Video page**: stage progress wraps to a vertical list at `< md`; action bar wraps; picks grid
  `1 / 2 / 3 / 4 / 5` columns (cards are 9:16 so they are narrow); YouTube embed keeps 16:9.
- **Clip editor**: `< lg` single column in the order preview → transcript → timeline → publish →
  post-time; `lg` two columns (preview+timeline | transcript+panels); `2xl` three columns.
  Preview height is capped by viewport (`max-h-[70vh]`) so the phone frame never overflows.
- No horizontal page scroll at any width; tap targets ≥ 40 px at `< md`.
- Verified by screenshots at 400, 768, 1280 and 2560 px (dev server + browser pane), and in the
  packaged app.

## 7. Testing
- Existing vitest suite stays green (fix the inherited fixture type error in
  `test/captions.test.ts`).
- New unit tests: `settings` (defaults, env fallback, file precedence, redaction, partial merge in
  a temp dir), `ensureToolPaths` (idempotent, prepends only missing), `access` (shape),
  `pickPort` (returns a bindable port), `doctor` (yields one result per check, `fix` present on
  failure).
- End-to-end, done by hand in this session: `pnpm desktop:pack` → launch → home renders →
  settings check passes → real clip job (short public video) → render → Show in Finder.

## Out of scope
Windows/Linux, code signing, auto-update, bundling ffmpeg/yt-dlp, real auth, payments,
face-tracked cropping.
