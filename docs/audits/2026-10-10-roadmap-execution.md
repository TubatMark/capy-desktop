# Roadmap execution evidence

Work is on `feat/capy-roadmap`, based on `2061efbfdf14d50bd3a999f048381d5b0a689d8e`, in an isolated managed worktree. The original checkout, media and existing work were preserved. Local implementation and source review are complete. Validation snapshots are distinguished below; this is not authorization for unattended publishing.

## Verified increments

| Task | Implementation and review | Evidence |
| --- | --- | --- |
| A1 publication identity | Immutable package, destination and revision eligibility; review fixes closed | 80 focused tests and typecheck |
| A2 storage | SQLite transactions, CAS, reversible JSON migration; review fixes closed | Actual packaged Node 24.21 / SQLite 3.53.4 WAL, commit, rollback, reopen and integrity |
| A3 worker | Durable stages, leases, cancellation, process supervision and fenced promotion; review fixes closed | Exact `67932c0`: 471 tests, typecheck, build, desktop pack; packaged API, import/proxy, two-worker single owner, SIGKILL takeover and subsequent successful import |
| A4 AI routing | Task routing, shared admission budgets, privacy and usage modes; review fixes closed | 37 focused tests, typecheck, two Settings browser flows |
| B1 renderer evaluation | Conservative ffmpeg adapter retained; no Hyperframes adoption | Simple 900-frame export; rich 900-frame export measured -12.0138 dB ducking and actual 100/300 ms ramps; b1589bc focused rich fixture took 27.97 s with sampled process-tree peak 1,230,192 KiB (fixture generation, render and verification included; not a true peak or throughput promise) |
| B2 editor | Durable imports/projects, revision conflicts, recovery, timeline operations, undo | 13 focused tests, typecheck, five browser flows; review fixes closed |
| B3 audio/layers | Source timing, audio/captions/layers, transforms and strict exact-time persistence; review fixes closed | Main: 491 tests and six browser flows; final fixes: 42 focused tests, typecheck, two targeted browser regressions |
| B4 export | Immutable normalized worker export, exact preview/download and Studio publication revision checks; SAR review fix closed | Final 19 renderer tests after fix; earlier 76 integration tests and browser flows; exact e89b494 packaged render/download/checksum/revision/failover passed; integrated source `0288627` package/runtime passed |
| B5 thumbnail generation | Source-grounded local designs, explicit image adapter, saved layer identity and actual font bounds; review fixes closed | Main: 511 tests; final fix: 20 focused tests, typecheck and actual PNG bounds/roundtrip; B4 exact source-time integration verified; B7 retiming integration reviewed |
| B6 thumbnail Studio | Three variants, manual frames, editable layers/crop, downloads/history, exact-version review and immutable attachment; review fixes closed | 67 initial focused tests; final 25 focused tests, three browser flows, exact restored PNG/geometry and typecheck |
| C1 source subscriptions | Separate read-only identity, paginated selection/import and no-backfill cutoff | 66 focused tests, full 504 tests, typecheck and two browser flows; review fixes closed |
| C2 discovery/events | Complete paginated reconciliation, durable readiness/deduplication, optional independent signed-event receiver; review clean | 52 focused tests, actual local callback replay/authenticated pull, scoped typecheck; integrated 710-test source snapshot passed |
| C3 automation policy | Admission, recipes, quality checks, pause controls and status; manual-job adoption review fixes closed | Final 95 focused tests and typecheck; earlier dashboard browser proof; one minor manual re-import cache inconsistency deferred for final review |
| B7 advanced editor | Retiming, freezes, transforms, templates, voice recording and reversible suggestions; review fixes closed | Final 74 focused tests, three browser flows and typecheck; decoded 60-second retiming, short-span content, stereo/pitch and cancellation; earlier full 608-test snapshot |

| C4 delivery recovery | Durable sessions, fenced mutation gates, distinct remote states, account refresh, scheduling capability gates and bounded real-worker fault harness; integration review fixes closed | 40 storage/account/recovery/schedule tests, 74 platform/worker/queue tests, required pair 15 tests, two browser flows and typecheck; short soak covers eight faults, 6.86 active seconds, zero lost artifacts or duplicate claims/acceptances; final recovery fixes: 88 related tests, then 15 scheduled-thumbnail/worker regressions and typecheck |
| C5 outcome feedback | Immutable actual-render attribution, raw provider metrics, manual recipe suggestions and scoped metrics deletion; review fixes closed | 79 focused tests including actual ffmpeg attribution proof, typecheck and two browser flows; final fix: 53 focused tests, typecheck, two browser flows and actual cross-process credential replacement fence |

Test totals belong to their named snapshots and must not be read as a final integrated branch result. Browser checks use isolated fixture data; packaged checks execute the produced application binary in Node mode, not an authenticated GUI session.

## Boundaries and release gates

- No connected-account actions, paid provider calls, publication, deployment, push or merge were performed.
- Automatic publication remains disabled. A real 72-hour fault-injected soak and separately authorized controlled destination upload are required before unattended enablement.
- Application admission budgets reserve bounded attempts/turn allowances and labeled cost estimates; they do not claim hard provider-internal request or invoice limits. Strict provider mode rejects adapters whose actual limits are unverified.
- Local thumbnail fallbacks are tested. Live image-model access, output quality, billing and provider eligibility remain unverified.
- Delivery recovery and outcome feedback task reviews are closed. The final integration fix wave `e38e88b` passed scoped review. Application source at `0288627` passed the full suite, typecheck, build, package and produced-binary checks; browser-only correction `6ae3930` passed all 24 browser flows.

The exact e89b494 full suite had 565 passing tests and one failing short-lease recovery fixture; a focused rerun passed all eight recovery tests. A deterministic scheduling-stall reproduction confirmed expiration of the test's 300 ms lease. Test-only fix `e7521c0` uses the production lease duration and explicit process handshakes; eight focused tests and four fault boundaries under controlled ffmpeg load passed, and independent review is clean. A later shared snapshot passed 608 tests. Those intermediate results are superseded by the final 710-test source snapshot recorded below.

## Whole-branch integration review

The broad review found four Important gaps: Studio/thumbnail writers bypassing durable delivery guards, incomplete migrated assets appearing ready, discovery restarting the same prefix after deadlines, and automatic SEO rewrites consuming derived API scores. Two smaller settings/proposal inconsistencies were also retained. One consolidated fix wave (`e38e88b`) addresses all six, with 106 focused tests, strengthened 14-test and five-test media checks, three browser regressions and typecheck. Retrospective baseline verification produced nine intended unit failures and one browser failure before fixed code was restored. Scoped final review approved all six findings. Integrated results follow; the two later corrections changed the fault fixture and browser setup, preserving application gates.

Legacy inventory now has explicit preparation/recovery into a new verified managed identity. Actual available/missing legacy fixtures run through durable probe/proxy, project creation and a two-second 1080×1920 export with checksum verification; originals and old approvals remain unchanged. Raw SEO research is display-only, and old derived cache entries cannot supply automatic rewrite context.

## Final local validation

- **Application/source snapshot `0288627`:** 710/710 tests across 87 files, 68.26 seconds; typecheck passed. `pnpm desktop:pack` completed the production Next build and unsigned ARM64 Electron package.
- **Produced application binary:** Electron Node 24.21.0 / SQLite 3.53.4 passed WAL persistence, rollback, reopen and integrity checks. Local API routes, real media import/proxy, two-worker single ownership, actual owner SIGKILL/takeover and subsequent import passed.
- **Actual exports:** 60-frame 1080×1920 H.264/AAC at 48 kHz, download checksum `05f3125c353bebc586143dfba81793627132c90b27f73a0ccbfa2be46eccda48`, retained historical revision and stale-after-edit checks passed. The 0.5× output had 120 frames, checksum `249ef71579530299b2689aa5106a8c5d219c9905f09f61afbee0bf12bc280a98`, decoded pitch 440 Hz and RMS 0.04411. This is actual packaged Node-mode execution, not a normal GUI launch against the user's data.
- **Browser snapshot `6ae3930`:** all 24 flows passed together in a fresh isolated store using default serial configuration, with no selected-file restriction, skips or retries. Typecheck passed. The six-file delta from `0288627` contains only Playwright configuration and test/fixture files; application source is unchanged.
- **Resource observations:** the packaged basic/retimed checks sampled owned server/worker/child process trees at approximately 200 ms. Observed peaks were 768,176 / 849,440 KiB and queue-plus-render times 1.56 / 2.63 seconds. These are scoped samples, not true peaks or universal throughput promises.

Failure history is retained rather than relabeled green. The first fresh checkout lacked the generated worker bundle. A later 709-pass run exposed a fault fixture that attempted authentication recovery without the newly required explicit retry; fixture-only repair `0288627` uses real queue retry solely for proven pre-intent authentication recovery, and its independent review passed. The initial combined browser run leaked Global Stop and creator state across files; the owned run was interrupted after diagnosis (nine passed, nine failed, one interrupted, five not run). Test-only repair `6ae3930` adds explicit local-work preconditions, scoped selectors, serial shared-backend execution and exact preservation assertions. The full corrected run passed, and independent review approved the six-file test-only delta without findings.

The build retains dynamic file-tracing/optional cross-platform dependency notices, and test logs retain expected SQLite/runtime warnings. Runtime proof is limited to the paths exercised above. No remote CI, deployment, signing/notarization, normal installed GUI session, paid model evaluation or live provider publishing is inferred.

## Running 72-hour gate

A detached isolated runner was started from the frozen `0288627` checkout on 2026-10-10. The source digest is `fdc161a8e4cd136c7f8d4968bc72520d20f50c820026cbaeaa2eef3cf98864cc`; current application/harness source matches it. Live metadata is in `.superpowers/sdd/2026-10-09-capy-roadmap/long-soak.json`; its `root/run.json` contains the current heartbeat, active duration and invariants. The retained directory is `runs/capy-isolated-soak-72h-lappryj_` under that plan workspace.

At 2026-10-10T09:19:39.035Z it was **running**, with 352.6 actively observed seconds, 6 fault episodes and no invariant failures. This is not a completed 72-hour result. Completion requires 259,200 actively observed seconds; sleep/downtime cannot supply that duration. Short-profile proof covered all eight faults, explicit fixture authentication retry, real SIGKILL/takeover, zero lost artifacts/duplicate claims/acceptances and an explicit unknown remote outcome. The long harness uses real fixture leases and delivery logic against a loopback fake provider; it does not prove production dispatcher behavior throughout, arbitrary mid-dispatch disk failures, live OAuth recovery or platform behavior.

Keep the frozen checkout and evidence directory while the runner is active. `docs/automation-soak.md` explains status, interruption and same-source resume. A separately authorized controlled upload with actual processing, scheduled visibility and thumbnail confirmation is still required afterward. Automatic publishing remains disabled.
