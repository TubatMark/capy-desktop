# Capy Automation, Editor and Thumbnails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution status:** Implementation was subsequently authorized and performed on `feat/capy-roadmap`. See the [execution evidence](../../audits/2026-10-10-roadmap-execution.md) and [decisions](../../audits/2026-10-10-roadmap-decisions.md). Unchecked external gates are intentionally not claimed complete.

**Goal:** Deliver a reliable creator-to-Shorts workflow with a usable video editor, AI-designed downloadable thumbnails, and explicitly enabled unattended YouTube publishing.

**Architecture:** Preserve Capy's pipeline and local desktop shell. Add durable jobs, a versioned project/asset model and immutable publishing packages; compile projects into preview/render plans. Adopt Hyperframes components only after a compatibility/export test proves they meet the editor's requirements.

**Tech Stack:** Existing Next.js 16.3.8, React 19, TypeScript, Electron, ffmpeg/ffprobe, Vitest; proposed SQLite, browser workflow tests, a reference-image-capable generation adapter, and conditional Hyperframes integration.

**Spec:** [Product and architecture specification](../specs/2026-10-09-capy-automation-editor-thumbnails.md). Evidence: [audit](../../audits/2026-10-09-automation-audit.md).

## Global Constraints

- Planning only in this change. Do not execute these tasks until implementation is requested.
- Read relevant installed `node_modules/next/dist/docs/` before implementing Next code; preserve AGENTS.md instructions.
- Preserve original media, existing JSON, user edits and untracked `videos/`; migrations must retain backups and support rollback.
- No automatic publishing enabled by migration, connection or subscription import.
- Editing, exporting and thumbnail downloads work without a posting account.
- Default thumbnail batch: three designs in one requested aspect ratio. Export presets: 1920×1080, 1080×1920 and 1080×1080, PNG/JPG.
- Default video export: 1080×1920, 30 fps, H.264/AAC. Timeline integers are project frames; source integers are microseconds.
- Only a shared eligibility check can authorize publication of an immutable package to its pinned destination.
- Use fixture media and isolated state in tests. Connected account/publication checks are separately authorized integration work.
- No new Stories features, subscription billing product, team collaboration or commercial media catalog in these releases.
- Task-specific AI routing defaults to Economical: deterministic operations use no LLM; simple text tasks use compact models; premium models require explicit configuration or bounded escalation. All retries/fallbacks share the task/day budget.

## Review Focus

- Interrupted migration or moved media folder preserves every original and reports unresolved assets — A2/B2.
- A changed edit, soundtrack, caption or thumbnail cannot publish under old approval — A1/B6/C4.
- Reordered mixed-frame-rate sources keep captions and audio aligned through preview/export — B2/B3/B4.
- No-face footage, low-quality frames or failed image generation still leave usable downloadable designs/originals — B5/B6.
- A sleeping/restarted worker or ambiguous platform response never silently loses a job or blindly duplicates a post — A3/C3/C4.

## Workstreams and order

| Plan | Deliverables | Dependencies |
|---|---|---|
| [A — Reliability](2026-10-09-capy-a-reliability.md) | Publish guard, database migration, supervised jobs, shared revision contracts | First |
| [B — Editor and thumbnails](2026-10-09-capy-b-editor-thumbnails.md) | Hyperframes evaluation, project editing, audio, preview/export, AI thumbnail studio | A contracts and persistence |
| [C — Discovery and unattended delivery](2026-10-09-capy-c-automation.md) | Subscriptions, polling/push, capacity/quality policies, verified publishing and monitoring | A; uses B revisions/templates |

Recommended sequence: A1 → A2 → A3 → A4 → B1 → B2 → B3 → B4 → B5 → B6 → C1 → C2 → C3 → C4. B1 evaluation can be performed before A2 completes if explicitly parallelized in a later execution session. No parallel agents are launched by this plan.

R5 follows with B7 (motion and advanced editing) and C5 (outcome feedback). Additional unattended platforms require their own capability and integration milestones.

Ship usable increments: existing workflow hardened; editor/export; thumbnails; automatic drafts; unattended YouTube. Keep the legacy clip editor available until the Studio equivalent passes migration and export tests.

## Shared contracts

Create `lib/studio/types.ts` for client-safe data and `lib/publication.ts` for publishing snapshots. These are the agreed interfaces between workstreams; use runtime validation at API and persistence boundaries.

| Type | Required fields/meaning |
|---|---|
| `AssetRef` | Stable `id`, media `kind`, `checksum`, managed location, duration/stream metadata, optional original job/video and source offset; missing/relink status |
| `ProjectDocument` | `schemaVersion`, `id`, `revision`, canvas width/height, rational fps, tracks, items, source mappings, caption cues, thumbnail references |
| `TimelineItem` | `id`, `trackId`, asset reference, integer `startFrame`/`durationFrames`, `sourceInUs`/`sourceOutUs`, transform, gain/fades or text properties as appropriate; speed initially 1 |
| `RenderArtifact` | `id`, project/revision, media checksum/path, probe results, renderer/version, completed review IDs |
| `ThumbnailDocument` | `id`, project/revision or legacy clip/render checksum, source-frame references, aspect preset, editable layers, versions, provider provenance, generation/review state |
| `PublishPackage` | `id`, artifact/checksum, posting-text snapshot, thumbnail revision/checksum if selected, platform/account ID, review/policy snapshot, package hash |
| `EligibilityResult` | `{allowed: boolean, reasons: string[]}`; explicit reasons for stale, blocked, missing, changed-account or uncertain state |
| `JobRecord` | `id`, kind, unique work key, input revision, stage, status, checkpoint, lease owner/generation/expiry, attempts, retryAt, cancellation and error |
| `AiTaskPolicy` | Task ID, capability, provider/model, context/output limits, timeout, retry limit, optional fallback/escalation, local/cloud permission and budget ceiling |
| `AiRunRecord` | Task/input version, actual provider/model, routing reason, attempts, latency, reported usage/cost or labeled estimate, outcome and cache identity |

Do not make rendered paths or clip numbers the unique identity of new assets. Legacy identifiers can be import references. Hash canonical manifests, media content and destination, not mutable object ordering or start/end alone.

## Working and verification convention

For each task: add its specified behavioral tests, confirm the expected failure, implement the listed interface, run the focused tests and typecheck, inspect the relevant UI/export if applicable, then make one reviewable commit. Avoid tests that only repeat implementation details. Test-path names below are proposed new files unless identified as existing.

Commands after dependencies are installed: `pnpm exec vitest run <test paths>`, `pnpm typecheck`; add `pnpm exec playwright test <spec>` when B2 introduces browser testing. At release boundaries run the full suite, `pnpm build`, `pnpm desktop:pack`, and isolated packaged smoke checks. Do not run builds against live posting state.

## Release decision

Automatic drafts can ship before unattended publishing. Enable unattended publishing only after all publish/recovery/identity gates pass, a 72-hour fault-injected soak completes, and a separately authorized controlled upload verifies the actual destination, processing and visibility. Hyperframes failure does not block the basic editor; image-provider failure does not remove existing thumbnails or videos.

Future execution should start with A1. This document does not authorize account connections, provider charges, deployment or public posting.

## Planning review completed

Coverage: audit findings 1–2 → A1; findings 4–5 → A2/A3; finding 3 → C4; finding 6 → C1/C2; findings 7–8 → C3; findings 9–10 → A3/C3/C4. Manual cut/merge → B2; sound/captions/layers → B3; preview/export → B1/B4; AI thumbnail creation/download → B5/B6; Hyperframes motion → B1/B7; outcome feedback → C5. Task-specific, proportionate model assignments and cost controls → A4, consumed by all AI-enabled tasks.

Known integration decisions have explicit tests: SQLite runtime compatibility in A2, Hyperframes adoption in B1, reference-image provider capability/budget in B5, and actual destination publishing/thumbnail eligibility in C4. These are execution-stage validation gates, not features claimed to exist today.
