# Capy Reliability Implementation Plan

> Execution status: checked items have local implementation/review evidence in [the execution audit](../../audits/2026-10-10-roadmap-execution.md). Final integrated validation remains pending. Unchecked Hyperframes adoption/benchmark and live model-evaluation steps are deferred; the shipped renderer is ffmpeg and provider quality/access is unverified.
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make existing jobs and publishing state durable, reviewable and safe to resume before adding more automation.

**Architecture:** Centralize publication decisions, import local state into a transactional repository, and move execution into a supervised worker. Retain existing pipeline/adapters behind typed revision and job contracts.

**Tech Stack:** Existing TypeScript/Next/Electron/Vitest/ffmpeg; SQLite driver selected and pinned through actual Node and packaged-runtime verification.

**Spec:** [Product specification](../specs/2026-10-09-capy-automation-editor-thumbnails.md); [master plan and shared contracts](2026-10-09-capy-roadmap.md).

## Global Constraints

All master-plan constraints apply. Original JSON/media and user WIP are preserved. Automatic publishing stays off. Credential values must not enter logs, fixtures or audit exports. Existing source revision and installed Next guides must be rechecked before editing.

## Review Focus

- Changed thumbnail/caption/audio must invalidate approval — A1.
- Different account reconnect cannot redirect old entries — A1.
- Corrupted or half-imported legacy state must not become an empty successful import — A2.
- Two processes and a stale lease must not both commit a task result — A3.
- Cancellation/restart between stages must terminate old work and resume the right stage — A3.

### A1: Central publication gate and immutable revisions

**Files:** create `lib/publication.ts`, `lib/studio/types.ts`, `server/publication-policy.ts`, `test/publication-policy.test.ts`; modify `lib/types.ts`, `server/queue.ts`, `server/poster.ts`, `server/connect.ts`, `app/api/queue/approve/route.ts`, `app/api/queue/[key]/route.ts`, `app/api/queue/[key]/[action]/route.ts`, `test/queue.test.ts`, `test/routes.test.ts`, `test/poster.test.ts`.

**Interfaces:** `buildPublishPackage(input: PublishPackageInput): PublishPackage`; `evaluatePublication(pkg: PublishPackage, context: PublicationContext): EligibilityResult`. `PublicationContext` contains current artifact/text/thumbnail hashes, connected account ID, review result, policy version and approval or explicitly enabled automatic policy. Shared data types are specified in the master plan.

- [x] Add `blocked_review_cannot_schedule_via_any_route`: approve without override, post-now, retry and move all refuse an unapproved blocked fixture. Explicit human override remains a separately recorded decision; automatic policy cannot override a block.
- [x] Add `changed_package_requires_new_decision`: independently mutate media, captions/audio render, posting text, thumbnail and destination; every mutation returns `allowed: false`. A reconnect to the same ID can recover; a different ID cannot.
- [x] Run `pnpm exec vitest run test/publication-policy.test.ts test/queue.test.ts test/routes.test.ts test/poster.test.ts`; confirm regressions fail before implementing.
- [x] Implement package hashing and eligibility, then route every schedule/publish action through it; recheck immediately before external upload. Preserve legacy packages as requiring review when their revision/account identity cannot be proven.
- [x] Run those tests and `pnpm typecheck`; confirm fresh valid package succeeds and all bypass fixtures fail closed. Commit `fix: bind publication to reviewed media and destination`.

### A2: Transactional storage and reversible import

**Files:** create `server/db/index.ts`, `server/db/migrations.ts`, `server/db/import-legacy.ts`, `server/repositories/jobs.ts`, `server/repositories/projects.ts`, `server/repositories/publications.ts`, `server/repositories/creators.ts`, `test/storage.test.ts`, `test/legacy-import.test.ts`; modify `server/jobs.ts`, `server/watch.ts`, `server/queue.ts`, `server/json-file.ts`, `package.json`, `scripts/desktop-build.mjs`.

**Interfaces:** `openStore(dataDir: string): Store`; `importLegacy(input: LegacyImportInput): Promise<ImportReport>`; `saveProject(doc: ProjectDocument, expectedRevision: number): Promise<ProjectDocument>`. `ImportReport` lists imported/skipped/unresolved/corrupt records and backup location. Stores expose transactions, versioned schemas and unique keys for source videos, work and destination-specific deliveries.

- [x] Add `migration_is_repeatable_and_reversible`: import fixture jobs/watch/queue twice; counts and identifiers remain stable, media is unchanged, backups exist, and a simulated interrupted import can restart. A malformed JSON fixture produces a visible error and no silent empty replacement.
- [x] Add `concurrent_save_preserves_newer_revision`: two saves from revision 4 produce one revision 5 and one conflict, never two successful overwrites. Add moved-folder and missing-asset cases; unresolved assets remain relinkable.
- [x] Run `pnpm exec vitest run test/storage.test.ts test/legacy-import.test.ts`; confirm missing repository behavior fails.
- [x] Verify and pin the SQLite driver using a temp database in development and packaged Electron's server runtime. Implement transactions/WAL, backup/import validation and repository adapters. Store schema versions; migrate copies and compare inventories before activation. Keep credentials out of the database migration and preserve the existing credential store initially.
- [x] Run focused tests/typecheck plus isolated packaged database open/transaction/reopen. Commit `feat: add durable local state and legacy import`.

### A3: Durable worker, cancellation and resource controls

**Files:** create `server/worker/main.ts`, `server/worker/runner.ts`, `server/worker/leases.ts`, `server/worker/budget.ts`, `electron/worker-service.ts`, `test/worker.test.ts`, `test/worker-recovery.test.ts`; modify `server/jobs.ts`, `server/watcher.ts`, `server/poster.ts`, `server/poster-lock.ts`, `src/exec.ts`, `server/platforms/types.ts`, `electron/main.ts`, `electron/server.ts`, `package.json`, `scripts/desktop-bundle.mjs`, `scripts/desktop-build.mjs`.

**Interfaces:** `enqueueWork(input: WorkInput): Promise<JobRecord>`; `claimWork(workerId: string, now: number): Promise<JobLease | null>`; `runJob(lease: JobLease, signal: AbortSignal): Promise<void>`; `cancelJob(id: string): Promise<void>`; `getWorkerHealth(): Promise<WorkerHealth>`. Every state-changing checkpoint validates lease generation. `WorkerHealth` reports heartbeat, active stages, resource limits and blocked reasons.

- [x] Add `one_owner_after_lease_expiry`: two real worker processes compete; only one claims a task; a stale owner's write is rejected after takeover.
- [x] Add `restart_resumes_first_incomplete_stage`: terminate before metadata, after transcript, during download and during render; resume without discarding completed assets. A timed-out subprocess tree is terminated before a replacement starts.
- [x] Add `limits_pause_without_data_loss`: disk reserve, queue capacity, AI budget and cancelled tasks prevent new expensive work while existing artifacts remain recoverable. HTTP/subprocess deadline expiry yields retryable or needs-action state according to error class.
- [x] Run `pnpm exec vitest run test/worker.test.ts test/worker-recovery.test.ts`; confirm failures, then implement durable runner and stage adapters. Next routes enqueue/query instead of owning timers. Add a launchd service install/start/status mechanism; enabling background startup is explicit and reversible.
- [x] Run focused tests/typecheck and packaged worker restart smoke. Verify opening a second app/dev instance does not create a second owner. Commit `feat: run media jobs in a supervised durable worker`.

### A4: Proportionate AI routing and usage controls

**Files:** create `lib/ai-policy.ts`, `server/ai-router.ts`, `server/ai-usage.ts`, `components/ai-routing-settings.tsx`, `test/ai-routing.test.ts`, `test/ai-budget.test.ts`; modify `src/agents.ts`, `server/settings.ts`, `app/api/settings/route.ts`, `components/settings-view.tsx`, `src/pick.ts`, `src/review.ts`, `src/translate.ts`, `src/seo/optimize.ts`, `src/content-review.ts`. B5 image adapters and C3 visual review must use this policy layer too.

**Interfaces:** `resolveAiTask(task: AiTaskId, context: AiTaskContext): AiTaskPolicy`; `reserveAiBudget(input: AiBudgetRequest): Promise<AiBudgetReservation>`; `recordAiRun(run: AiRunRecord): Promise<void>`. AiTaskId identifies transcription, clip selection, translation, metadata, review, vision, thumbnail generation, edit assistance or optional performance summary. Context includes input version, required modality, local/cloud permission, creator override and retry/escalation history. Budget reservations are transactional across workers and reconciled to actual or labeled estimated cost.

- [x] Add `simple_tasks_do_not_use_premium_models`: Economical routes metadata/headlines to the configured compact model; media resizing/cutting/scheduling invoke no model; a premium route requires explicit policy. Capability mismatch cannot route image work to a text-only adapter.
- [x] Add `retry_and_escalation_share_budget`: concurrent requests cannot overspend the reserved ceiling; default one retry/one configured escalation terminates without loops. Creator overrides cannot raise global limits. Unknown price is flagged, not treated as free; subscription mode enforces usage limits.
- [x] Add `cache_and_context_are_task_scoped`: identical input/schema/model/parameters reuse results; changed transcript, model or prompt invalidates cache. A title request gets selected-clip context, not the full video. Editing thumbnail text has zero provider calls.
- [x] Add `review_failure_never_auto_approves`: failed/ambiguous reviewer escalates only as configured or returns needs-review. Local-only policy rejects cloud fallback; premium image quality is opt-in.
- [ ] Run `pnpm exec vitest run test/ai-routing.test.ts test/ai-budget.test.ts`; confirm failures, implement routing settings and usage records. Keep adapter capability separate from provider branding; select exact model defaults using current capability/pricing checks and a labeled clip evaluation set, not model self-confidence.
- [x] Run focused tests/typecheck and inspect task assignments plus per-task usage in Settings. Commit `feat: route AI tasks by capability quality and budget`.

Completion: the existing assisted workflow still works, original files remain accessible, publication decisions are versioned, worker death no longer silently loses execution state, and simple tasks cannot silently consume premium models. Actual external upload recovery is completed in C4.
