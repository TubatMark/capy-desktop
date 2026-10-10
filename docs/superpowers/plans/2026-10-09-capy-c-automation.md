# Capy Creator Automation Implementation Plan

> Execution status: checked items have local implementation/review evidence in [the execution audit](../../audits/2026-10-10-roadmap-execution.md). Final integrated validation remains pending. Unchecked Hyperframes adoption/benchmark and live model-evaluation steps are deferred; the shipped renderer is ffmpeg and provider quality/access is unverified.
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect selected creators' new uploads, produce edits/thumbnails within capacity, and reliably publish eligible packages to the intended YouTube destination.

**Architecture:** Subscription import and channel reconciliation feed durable jobs. Creator policies drive the editor/thumbnail templates and quality gates. A supervised worker verifies eligibility and reconciles external delivery; the UI exposes exceptions and operational health.

**Tech Stack:** Existing YouTube/OAuth/platform modules, durable worker/SQLite from A, Studio/thumbnail contracts from B, HTTP WebSub receiver, Vitest and Playwright.

**Spec:** [Product specification](../specs/2026-10-09-capy-automation-editor-thumbnails.md); [master contracts](2026-10-09-capy-roadmap.md). Requires A; creator template execution uses B.

## Global Constraints

All master constraints apply. Subscription-reading identity and publishing identity are separate. Importing a creator does not enable publication. Default proposed capacity is a three-day queue target, seven-day maximum unpublished backlog and configurable 72-hour source freshness limit. Thumbnail generation defaults to three variants in one aspect. Public/paid integration work is not authorized by this planning document.

## Review Focus

- More than one subscription page or more than 12 missed uploads must not lose items — C1/C2.
- Duplicate/edit events, premieres, private/deleted videos and destination-channel loops need explicit outcomes — C2.
- Queue saturation/model failure must defer work with a visible reason, not spend indefinitely or publish unchecked — C3.
- Lost responses after remote acceptance must not trigger blind duplicate uploads — C4.
- Missing analytics must be shown as unavailable, never zero performance or proof of a bad clip — C5.

### C1: Subscription import and separate account roles

**Files:** create `server/subscriptions.ts`, `components/subscription-picker.tsx`, `app/api/subscriptions/route.ts`, `test/subscriptions.test.ts`, `test/e2e/subscriptions.spec.ts`; modify `server/accounts.ts`, `server/connect.ts`, `server/oauth.ts`, `components/accounts-panel.tsx`, `components/automation-view.tsx`, `lib/types.ts`.

**Interfaces:** `listSubscriptions(accountId: string, cursor?: string): Promise<SubscriptionPage>`; `importCreators(input: CreatorImport): Promise<ImportCreatorsResult>`. A subscription page contains channel IDs/names/thumbnails and next cursor; import contains selected IDs, reading account, explicit backfill choice and initial mode `manual` or `automatic_drafts`.

- [x] Add `import_all_pages_without_duplicates`: 120 fixture subscriptions across pages import exactly the selected unique IDs; reconnect to a different reading account is visible and does not alter publishing destinations.
- [x] Add `import_never_enables_publication`: no default backfill or auto-publish, no subscription deletion on YouTube, and existing creator preferences survive a refresh. Revoked scope/access produces a reconnect action.
- [x] Run `pnpm exec vitest run test/subscriptions.test.ts`; confirm failures, implement readonly import, pagination, search/select and source-vs-destination account labels. Migrate existing posting credentials as destination credentials without assuming they are the subscription source.
- [x] Run focused tests, `pnpm exec playwright test test/e2e/subscriptions.spec.ts` and typecheck. Commit `feat: import selected YouTube subscriptions`.

### C2: Complete discovery and optional push events

**Files:** create `server/discovery/reconcile.ts`, `server/discovery/readiness.ts`, `server/discovery/events.ts`, `services/youtube-events/handler.ts`, `services/youtube-events/subscriptions.ts`, `test/discovery.test.ts`, `test/youtube-events.test.ts`; modify `server/watcher.ts`, `server/watch.ts`, `src/youtube-api.ts`, `components/automation-view.tsx`.

**Interfaces:** `reconcileCreator(channelId: string, signal: AbortSignal): Promise<DiscoveryResult>`; `checkVideoReadiness(videoId: string): Promise<VideoReadiness>`; `ingestChannelEvent(event: ValidatedChannelEvent): Promise<EventReceipt>`. Store last successful cursor/watermark and durable video IDs separately from processing status. Readiness is ready, wait-until, unavailable or excluded, with a reason.

- [x] Add `outage_recovers_more_than_twelve`: simulate 40 unseen uploads, paginated listings and a failed page; recover every eligible ID without advancing the success cursor past incomplete work. Repeated reconciliation creates one work item per configured source/revision.
- [x] Add `event_edits_do_not_reclip`: upload, duplicate and metadata-change events for one video produce one source job. Live/premiere waits; deleted/private and filtered Shorts have explicit status. Skip configured destination channels to prevent recursive production.
- [x] Add `one_slow_channel_does_not_block_others`: deadline/backoff isolates failures. Webhook challenges validate expected topics/tokens; malformed, oversized and replayed payloads cannot start duplicate work. Renew leases and authenticate worker event retrieval.
- [x] Run `pnpm exec vitest run test/discovery.test.ts test/youtube-events.test.ts`; confirm failures, implement paginated uploads reconciliation first, followed by optional receiver. Keep receiver storage/API separate from the local Next API; do not expose desktop credentials.
- [x] Run focused tests/typecheck and a local callback replay integration test. Commit polling support and event support as independently reviewable changes; deployment is a later authorized action.

### C3: Creator recipes, media quality and operations dashboard

**Files:** create `lib/creator-policy.ts`, `server/automation-policy.ts`, `server/media-quality.ts`, `server/worker/health.ts`, `components/automation-dashboard.tsx`, `components/creator-policy-form.tsx`, `app/api/automation/health/route.ts`, `test/automation-policy.test.ts`, `test/media-quality.test.ts`, `test/e2e/automation-policy.spec.ts`; modify `server/watcher.ts`, `server/jobs.ts`, `server/tasks.ts`, `server/todo.ts`, `components/automation-view.tsx`, `electron/tray.ts`, `server/settings.ts`.

**Interfaces:** `planCreatorWork(input: CreatorWorkInput): WorkDecision`; `checkMedia(artifact: RenderArtifact): Promise<MediaQualityReport>`; `automationHealth(): Promise<AutomationHealth>`. WorkDecision is proceed/defer/skip with reason, proposed recipe, budget and destination. Recipes reference immutable edit/thumbnail templates. MediaQualityReport includes measured checks, optional model assessment and review version.

- [x] Add `capacity_limits_cost_before_render`: six sources proposing 18 clips cannot render beyond the configured destination/backlog budget; choose/rank candidates first, preserve defer reasons and expire only under explicit freshness policy. Manual user imports remain available outside automated intake caps.
- [x] Add `auto_mode_requires_passing_current_package`: disabled/manual/draft modes never publish; automatic mode requires current source permission, media checks, destination and review. Missing/blocked/unavailable review routes to exceptions. Required-thumbnail failure blocks publication; optional-thumbnail policy uses only its configured fallback.
- [x] Add `quality_catches_real_bad_media`: decode/truncation failure, silence, black frames, caption overflow and wrong aspect fail appropriate checks. Speech/face-free footage must not fail merely for having no face/dialogue. Frame/audio model review is supplementary, separately identified and bounded by budget.
- [x] Run `pnpm exec vitest run test/automation-policy.test.ts test/media-quality.test.ts`; confirm failures, implement recipe application and dashboard with last success, heartbeat, active stage, oldest pending item, next post, disk/budget and account health. Separate monitor/render/post pauses and add a global stop for future work.
- [x] Run focused tests/browser policy flows/typecheck. Verify every skipped/deferred/failed item has a user-readable explanation. Commit `feat: add bounded creator recipes and automation health`.

### C4: Durable upload recovery and verified publication

**Files:** create `server/delivery.ts`, `server/platform-capabilities.ts`, `test/delivery-recovery.test.ts`, `test/platform-capabilities.test.ts`, `test/automation-soak.test.ts`; modify `server/poster.ts`, `server/platforms/youtube.ts`, `server/platforms/instagram.ts`, `server/platforms/tiktok.ts`, `server/platforms/types.ts`, `server/accounts.ts`, `components/queue-view.tsx`, `components/accounts-panel.tsx`, `app/settings/posting-setup/page.tsx`, `README.md`.

**Interfaces:** `deliverPackage(packageId: string, signal: AbortSignal): Promise<DeliveryState>`; `reconcileDelivery(deliveryId: string): Promise<DeliveryState>`; `getDestinationCapabilities(accountId: string): Promise<DestinationCapabilities>`. Delivery states include queued, uploading, uploaded, processing, scheduled, public, needs-action, failed and delivery-unknown; result IDs/session URLs are persisted with restricted access.

- [x] Add `lost_success_response_is_reconciled`: simulate interruption before session creation, after session creation, after media acceptance and after publication. Resume/query where supported; an unresolved outcome stays delivery-unknown instead of issuing a new blind upload.
- [x] Add `destination_and_revision_rechecked_at_upload`: switch account or update video/text/thumbnail after scheduling; refuse the old package. Token refresh is synchronized per account; transient failures and quota exhaustion have distinct retry timing.
- [x] Add `remote_state_is_not_assumed_public`: processing/private/inbox states remain distinct from public. Thumbnail attachment records its own success/failure. Never infer lack of an audit solely from non-public privacy. Keep current TikTok assisted behavior until an eligible publishing flow is separately established.
- [x] Run `pnpm exec vitest run test/delivery-recovery.test.ts test/platform-capabilities.test.ts`; confirm failures, implement early checkpointing, status reconciliation, eligible YouTube upload-ahead/scheduling and capability-aware UI. Update stale quota/setup claims from primary docs at implementation time.
- [ ] Run unit/fixture integration checks, then a 72-hour isolated worker soak with process, network, auth, disk and lease faults. Record zero lost completed artifacts, zero duplicate local delivery claims, and explicit unresolved remote outcomes. Run full tests/build/packaged smoke. Commit `feat: verify and recover scheduled video delivery`.
- [ ] When separately authorized and accounts are configured, perform a controlled actual upload to the selected destination; verify remote ID, processing, scheduled transition/visibility and thumbnail outcome. Only then offer explicit unattended enablement for that creator/destination.

### C5: Outcome feedback and subsequent platform milestones

**Files:** create `server/performance.ts`, `components/channel/clip-performance.tsx`, `test/clip-performance.test.ts`; modify `server/channel.ts`, `server/seo.ts`, `components/channel/channel-view.tsx` and creator recipe controls.

**Interfaces:** `refreshPublicationMetrics(destinationId: string): Promise<MetricsRefresh>`; `summarizeRecipePerformance(recipeId: string): Promise<RecipePerformance>`. Join remote IDs to source videos, edit recipes and thumbnail versions; store measurement time and availability for each metric.

- [x] Add `missing_metrics_are_not_zero`: delayed/unavailable analytics show unavailable/last updated; they do not automatically penalize a template. Separate view totals from retention/engaged metrics where actually supported.
- [x] Add `compare_only_attributed_versions`: performance attaches to the published media/thumbnail revision, and a manual thumbnail change records uncertainty. Do not label heuristic scores or non-random comparisons as proven causal lift.
- [x] Run `pnpm exec vitest run test/clip-performance.test.ts`; confirm failures, implement user-visible suggestions for creator/topic/length/template changes with manual adoption first. Run focused tests/typecheck; commit `feat: attribute clip results to editing recipes`.
- [ ] Before adding another unattended platform, write its own capability/consent and recovery fixtures, verify actual eligibility and connect/publish only under separate authorization. Instagram and TikTok do not inherit a YouTube success claim.

Completion: creator discovery and draft production can run unattended within resource limits, while publication is tied to verified package/account state. Offline Macs are explicitly shown as offline; continuous processing during sleep requires a separately deployed always-on worker.
