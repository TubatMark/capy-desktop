# capy-desktop — implementation plan

Spec: `docs/superpowers/specs/2026-09-27-capy-desktop-design.md`. Read it first; section numbers
below refer to it.

Execution: foundation (task 0) is done by the coordinator, then tasks A, B, C run in parallel as
subagents with **strict file ownership** (a task may only create/edit the files listed under it),
then task D integrates and verifies. Every task runs `pnpm test` and `pnpm typecheck` before
reporting; errors in files owned by another task are reported, not fixed.

## Task 0 — foundation (coordinator)
- Fix `test/captions.test.ts` fixture (add `ytTitle`, `description`, `hashtags`).
- `lib/types.ts`: add `Access`, `AppSettings`, `MODELS`, `CheckResult`.
- Contract stubs so tasks compile independently: `hooks/use-access.ts`,
  `components/access-gate.tsx`, `app/api/jobs/[id]/reveal/route.ts`.
- `app/layout.tsx`: `data-desktop` attr, Settings nav link, responsive header;
  `app/globals.css`: desktop title-bar drag block.
- Commit.

## Task A — Electron shell + packaging (§2)
Owns: `electron/**`, `build/**`, `scripts/desktop-*.mjs`, `package.json`, `pnpm-lock.yaml`,
`next.config.ts`, `.gitignore`, `electron-builder.yml`, `test/port.test.ts`.
1. Add devDeps `electron@44`, `electron-builder@26`, `esbuild`; scripts `desktop:dev`,
   `desktop:build`, `desktop:pack`, `desktop:bundle` (esbuild only).
2. `next.config.ts`: `output: "standalone"`.
3. `electron/port.ts` (`pickPort`) + test; `electron/server.ts` (spawn prod or dev server, wait
   for readiness, stderr ring buffer, stop()); `electron/window-state.ts`; `electron/menu.ts`;
   `electron/main.ts`.
4. `scripts/desktop-build.mjs`: next build → copy `public` and `.next/static` into standalone →
   esbuild `electron/main.ts` → `dist-electron/main.cjs` → electron-builder.
5. `build/icon.png` from `public/capy-mark.png` via `sips -z 1024 1024` (pad to square first if
   needed; a 688² source is acceptable).
6. Verify: `pnpm desktop:dev` opens a window showing the home page; `pnpm desktop:pack` produces
   `dist/mac-arm64/capy.app` that launches and shows the home page. Report the exact commands
   and what you saw.

## Task B — settings, setup check, access (§3–5)
Owns: `server/settings.ts`, `server/doctor.ts`, `server/access.ts`, `server/paths.ts`,
`server/jobs.ts` (settings precedence only), `src/exec.ts`, `src/cli.ts`, `src/pick.ts`,
`app/api/**` (except `reveal`), `app/settings/**`, `components/settings-form.tsx`,
`components/setup-check.tsx`, `components/access-gate.tsx`, `hooks/use-access.ts`,
`test/settings.test.ts`, `test/exec.test.ts`, `test/access.test.ts`, `test/doctor.test.ts`,
`README.md` (new "Sharing this app later" section + Settings docs).
1. `ensureToolPaths()` in `src/exec.ts` + test.
2. `server/settings.ts`: load/save/redact/applyToEnv, precedence per §3.2; tests in a temp
   `CAPY_DATA_DIR`. `server/paths.ts` and `server/jobs.ts` read it (browser, model).
   `src/pick.ts` honours `claudeAuth` via env set by `applyToEnv()`.
3. `server/access.ts` + `GET /api/me`; gate `POST /api/jobs` and `POST /api/jobs/[id]/render`.
   Flesh out `hooks/use-access.ts` and `components/access-gate.tsx` (keep the stub's exported
   contract exactly).
4. `server/doctor.ts` (`runChecks`), `src/cli.ts doctor()` consumes it, `GET /api/check` SSE.
5. `app/settings/page.tsx`, `components/settings-form.tsx`, `components/setup-check.tsx`,
   `GET/PUT /api/settings`. Home banner is Task C's (they read `checkedAt` via `/api/settings`).
6. Verify in the browser pane (`pnpm dev` on port 3001): settings save and reload, check runs and
   streams, `/api/me` returns the local owner.

## Task C — responsive layout (§6)
Owns: `app/page.tsx`, `app/v/**`, `app/globals.css` (below the foundation block), `components/*`
except Task B's files, `hooks/use-job.ts`.
1. Rework every component/page listed in §6 for 360–2560 px. Use Tailwind breakpoints; container
   queries where a component's width, not the viewport, decides (picks grid, editor columns).
2. Add "Show in Finder" button on the video page (`POST /api/jobs/[id]/reveal`), wrap URL form
   submit and Render button with `<AccessGate>`, add the setup-check banner on Home (reads
   `GET /api/settings`, hides when `checkedAt` set, dismiss stored in `localStorage`).
3. Verify with the browser pane at 400, 768, 1280, 2560 px on Home, a video page and a clip
   editor (use an existing job under `output/` if present; otherwise create one from a short
   public video). No horizontal scroll; screenshots saved to the scratchpad and listed in the
   report.

## Task D — integration + verification (coordinator)
- `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm desktop:pack`; launch the app; run a real
  job end to end; screenshots at the four widths in the packaged app.
- Fix cross-task seams; update README; commit.
