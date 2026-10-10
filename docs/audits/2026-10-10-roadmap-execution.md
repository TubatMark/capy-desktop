# Roadmap execution evidence

Work is on `feat/capy-roadmap`, based on `2061efbfdf14d50bd3a999f048381d5b0a689d8e`, in an isolated managed worktree. The original checkout, media and existing work were preserved. This is an in-progress evidence record; task completion is not release authorization.

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
| B4 export | Immutable normalized worker export, exact preview/download and Studio publication revision checks; SAR review fix closed | Final 19 renderer tests after fix; earlier 76 integration tests and browser flows; exact e89b494 packaged render/download/checksum/revision/failover passed; final-fix package pending |
| B5 thumbnail generation | Source-grounded local designs, explicit image adapter, saved layer identity and actual font bounds; review fixes closed | Main: 511 tests; final fix: 20 focused tests, typecheck and actual PNG bounds/roundtrip; B4 exact source-time integration verified; B7 retiming integration reviewed |
| B6 thumbnail Studio | Three variants, manual frames, editable layers/crop, downloads/history, exact-version review and immutable attachment; review fixes closed | 67 initial focused tests; final 25 focused tests, three browser flows, exact restored PNG/geometry and typecheck |
| C1 source subscriptions | Separate read-only identity, paginated selection/import and no-backfill cutoff | 66 focused tests, full 504 tests, typecheck and two browser flows; review fixes closed |
| C2 discovery/events | Complete paginated reconciliation, durable readiness/deduplication, optional independent signed-event receiver; review clean | 52 focused tests, actual local callback replay/authenticated pull, scoped typecheck; integrated validation pending |
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
- Delivery recovery and outcome feedback task reviews are closed. The final integration fix wave is committed as `e38e88b`; its scoped review and exact-source integrated validation remain pending.

The exact e89b494 full suite had 565 passing tests and one failing short-lease recovery fixture; a focused rerun passed all eight recovery tests. A deterministic scheduling-stall reproduction confirmed expiration of the test's 300 ms lease. Test-only fix `e7521c0` uses the production lease duration and explicit process handshakes; eight focused tests and four fault boundaries under controlled ffmpeg load passed, and independent review is clean. A later shared snapshot passed 608 tests, but this record does not claim a green final integrated suite.

## Whole-branch integration review

The broad review found four Important gaps: Studio/thumbnail writers bypassing durable delivery guards, incomplete migrated assets appearing ready, discovery restarting the same prefix after deadlines, and automatic SEO rewrites consuming derived API scores. Two smaller settings/proposal inconsistencies were also retained. One consolidated fix wave (`e38e88b`) addresses all six, with 106 focused tests, strengthened 14-test and five-test media checks, three browser regressions and typecheck. Retrospective baseline verification produced nine intended unit failures and one browser failure before fixed code was restored. Scoped final review and the frozen-checkout full suite/build/package/browser checks are still pending in this record.

Legacy inventory now has explicit preparation/recovery into a new verified managed identity. Actual available/missing legacy fixtures run through durable probe/proxy, project creation and a two-second 1080×1920 export with checksum verification; originals and old approvals remain unchanged. Raw SEO research is display-only, and old derived cache entries cannot supply automatic rewrite context.
