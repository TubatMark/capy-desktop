# Capy Editor and AI Thumbnails Implementation Plan

> Execution status: checked items have local implementation/review evidence in [the execution audit](../../audits/2026-10-10-roadmap-execution.md). Final integrated validation remains pending. Unchecked Hyperframes adoption/benchmark and live model-evaluation steps are deferred; the shipped renderer is ffmpeg and provider quality/access is unverified.
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users assemble and polish clips, add sound, and create professional downloadable thumbnails grounded in the actual footage.

**Architecture:** A canonical project document drives editing, preview and export. Media assets and thumbnail layers are versioned independently; immutable finished revisions integrate with the worker and publication policy from A. Hyperframes is a conditional renderer/UI integration, not a second project database.

**Tech Stack:** React/TypeScript, existing ffmpeg/ffprobe, SQLite repositories, Vitest and Playwright; conditional Hyperframes Studio/producer; provider-neutral image editing interface and deterministic local image compositor.

**Spec:** [Product specification](../specs/2026-10-09-capy-automation-editor-thumbnails.md); [master contracts](2026-10-09-capy-roadmap.md). Prerequisite: A1–A3 for persistence/execution.

## Global Constraints

All master constraints apply. Default video export is 1080×1920 at 30 fps, H.264/AAC. Source media never changes in place. Timeline edits and export use the same project revision. Thumbnails default to three variations in one aspect; PNG/JPG sizes are 1920×1080, 1080×1920 or 1080×1080. No posting account is required. No arbitrary generated HTML runs with application privileges.

## Review Focus

- A sequence assembled from mixed/VFR/rotated sources retains sync and source mapping — B2/B4.
- A drag or keyboard shortcut does not destroy another tab's newer edit or intercept text entry — B2.
- Cut/reorder/ripple operations carry linked audio and captions correctly — B3/B4.
- No-face/blurred footage and failed generation preserve usable old versions — B5/B6.
- Provider output or thumbnail resizing cannot change factual subject identity or silently overflow text — B5/B6.

### B1: Hyperframes integration decision

**Files:** create `docs/decisions/hyperframes-integration.md`, `src/studio/renderer.ts`, `src/studio/hyperframes-adapter.ts`, `test/renderer-contract.test.ts`; modify `package.json` and packaging configuration only if the experiment passes. Put disposable fixture compositions under the test fixture directory, not the user's `videos/` project.

**Interfaces:** `compileProject(project: ProjectDocument, assets: AssetRef[]): RenderPlan`; `renderProject(plan: RenderPlan, signal: AbortSignal): Promise<RenderArtifact>`. `RenderPlan` records renderer version, frame count, resolved local assets, audio plan and composition properties. Preview consumes the same plan.

- [x] Create one 30-second fixture containing two cuts, captions, a text overlay, crossfade and music ducking; expected duration is 900 frames at 30 fps. Record the reference frames and audio timing.
- [ ] Verify current package/license/embedding contracts and pin a tested Hyperframes version. Test Studio/player integration in React/Next, source-to-timeline mapping, edit round-trip, arbitrary seeking and offline packaged Electron rendering.
- [ ] Compare preview/export at cut boundaries and three midpoints; allow at most one frame timing error. Require zero missing assets/fonts, zero caption overflow and no cumulative sync error above one frame. Record render time/memory on the test Mac rather than inventing throughput claims.
- [x] Write the decision: adopt the adapter if every correctness/packaging gate passes; otherwise implement the same contract with ffmpeg for R1 and explicitly defer rich motion. Enumerate every unsupported operation visibly. Commit `docs: decide studio rendering integration` with the isolated experiment/contract tests.

### B2: Project and timeline editor

**Files:** create `lib/studio/operations.ts`, `server/studio/assets.ts`, `server/studio/projects.ts`, `components/studio/editor.tsx`, `components/studio/timeline.tsx`, `components/studio/asset-bin.tsx`, `components/studio/history.tsx`, `app/studio/[id]/page.tsx`, `app/api/studio/projects/route.ts`, `app/api/studio/projects/[id]/route.ts`, `app/api/studio/assets/route.ts`, `test/studio-operations.test.ts`, `test/studio-projects.test.ts`, `test/e2e/studio.spec.ts`, `playwright.config.ts`; modify `components/clip-editor.tsx`, `components/video-view.tsx`, `components/sidebar.tsx`, `package.json`.

**Interfaces:** `createProject(input: ProjectSeed): Promise<ProjectDocument>`; `applyEdit(doc: ProjectDocument, operation: EditOperation): EditResult`; `importAsset(input: AssetImport): Promise<AssetRef>`. `EditOperation` supports split, trim, move/reorder, duplicate, remove, ripple-delete, add asset and transform. `EditResult` contains next document and inverse operation for undo. Persist using A2's expected-revision save.

- [x] Add `split_trim_reorder_preserves_sources`: split a 300-frame item at frame 90; obtain 90/210-frame items with contiguous source mapping; undo restores the original; remove/reorder never mutate source files. Reject zero/negative/out-of-range spans.
- [x] Add `merge_creates_new_project`: combine clips from two original jobs and import local media; source jobs remain unchanged. A manually chosen source range beyond the cached segment creates the correct footage request and waiting state.
- [x] Add browser coverage for selection, drag snapping, keyboard split/delete, text-field shortcut isolation, undo/redo, autosave/reopen, conflicting revision save and missing-media relink. Use isolated storage and fixture sources.
- [x] Run `pnpm exec vitest run test/studio-operations.test.ts test/studio-projects.test.ts`; confirm failures, implement asset import, model/operations and Studio UI. Add proxy generation/asset probe jobs with clear readiness states.
- [x] Run focused tests, `pnpm exec playwright test test/e2e/studio.spec.ts` and typecheck. Commit `feat: add nondestructive multi-clip studio`.

### B3: Audio, captions and visual layers

**Files:** create `lib/studio/audio.ts`, `lib/studio/caption-map.ts`, `components/studio/audio-panel.tsx`, `components/studio/layers-panel.tsx`, `components/studio/captions-panel.tsx`, `src/studio/audio-plan.ts`, `test/studio-audio.test.ts`, `test/studio-caption-map.test.ts`; modify B2 timeline/operations, `lib/studio/types.ts`, `components/caption-overlay.tsx` as a reusable presentation component where compatible.

**Interfaces:** `mapCaptionCues(doc: ProjectDocument, words: SourceWords[]): CaptionCue[]`; `buildAudioPlan(doc: ProjectDocument, assets: AssetRef[]): AudioPlan`. Source words retain asset ID and microsecond boundaries. Audio plan represents source clips, gain envelopes, loops, mute/solo and ducking against dialogue.

- [x] Add `captions_follow_ripple_and_reorder`: remove the middle 60 frames of a 300-frame sequence; removed words disappear and later words shift exactly 60 frames. Reordering repeated source ranges produces independently positioned cues.
- [x] Add `audio_controls_match_timeline`: trims/gain/fades/loop endpoints and detach/relink maintain duration; ducking lowers music during dialogue and restores it afterward without clipping. Use a proposed default 12 dB reduction with 100 ms attack/300 ms release, all editable.
- [x] Run `pnpm exec vitest run test/studio-audio.test.ts test/studio-caption-map.test.ts`; confirm failures, implement panels and audio/caption mapping. Add imported music/SFX/voiceover, waveforms, mute/solo, editable captions, B-roll/image/text layers, safe areas and cut/crossfade transitions.
- [x] Extend `test/e2e/studio.spec.ts` to add a sound, adjust volume, move a caption, add an overlay and undo each. Run tests/typecheck; commit `feat: add studio audio captions and layers`.

### B4: Preview, export and publication revision integration

**Files:** create `src/studio/ffmpeg-adapter.ts` if B1 selects it, `server/studio/render.ts`, `components/studio/preview.tsx`, `components/studio/export-panel.tsx`, `app/api/studio/projects/[id]/render/route.ts`, `test/studio-render.test.ts`, `test/e2e/studio-export.spec.ts`; modify B1 adapter, `src/render.ts` only for reusable primitives, `server/poster.ts`, `server/publication-policy.ts`.

**Interfaces:** `requestProjectRender(projectId: string, revision: number, preset: ExportPreset): Promise<JobRecord>`; renderer contracts from B1. `ExportPreset` selects aspect/fps/codec settings. A completed artifact attaches to the exact project revision; a failed/cancelled render never replaces a valid artifact.

- [x] Add `mixed_media_export_matches_preview`: 60-second synthetic edit with mixed fps, portrait rotation, silent clip and 44.1/48 kHz audio; captions/cuts and cumulative A/V sync stay within one output frame. Unsupported/HDR inputs are normalized under a recorded policy or rejected clearly.
- [x] Add `old_render_cannot_overwrite_new_revision`: edit during a render; finished old artifact stays attached to old revision and cannot publish as the new one. Audio/caption changes invalidate the previous publication package.
- [x] Run `pnpm exec vitest run test/studio-render.test.ts`; confirm failures, implement worker rendering, preview transport, aspect presets and immutable artifact registration.
- [x] Run real ffmpeg render/probe/frame comparisons plus `pnpm exec playwright test test/e2e/studio-export.spec.ts`, full focused tests and typecheck. Commit `feat: export reviewed studio revisions`.

### B5: Frame-grounded thumbnail generation

**Files:** create `lib/thumbnails.ts`, `src/thumbnails/frames.ts`, `src/thumbnails/brief.ts`, `src/thumbnails/provider.ts`, `src/thumbnails/compose.ts`, `server/thumbnails.ts`, `test/thumbnail-frames.test.ts`, `test/thumbnail-generation.test.ts`; reuse `src/pipeline.ts` frame extraction primitives and existing rendered-clip references.

**Interfaces:** `extractFrameCandidates(source: ThumbnailSource, signal: AbortSignal): Promise<FrameCandidate[]>`; `buildThumbnailBrief(input: ThumbnailBriefInput): ThumbnailBrief`; `ImageProvider.generate(input: ImageRequest, signal: AbortSignal): Promise<ImageResult>`; `generateThumbnails(input: ThumbnailRequest): Promise<JobRecord>`. Requests include source-frame references, exact edit/render identity, selected aspect, style, headline and variant count (default 3, maximum 3 per request). Provider results record asset paths, capability/model and reported usage. Reject source-free generation for this workflow.

- [x] Add `candidate_frames_are_distinct_and_traceable`: rank 8–12 candidates when enough distinct material exists; retain frame/source time mapping; exclude black/near-duplicates. No-face footage remains eligible; low-quality-only footage produces an explicit fallback and manual selector.
- [x] Add `generation_uses_selected_frames`: fake provider must receive actual selected frame assets and faithful subject instructions; three variants have distinct briefs and the same source revision. No image-capable provider yields local template designs plus a clear unavailable-generation status, never a text model masquerading as image generation.
- [x] Add `failure_preserves_versions_and_budget`: retry has a bounded allowance; existing designs survive failure; daily cap stops new calls; media edits mark generated designs stale. Provider upload scope includes only selected frames and necessary brief text.
- [x] Run `pnpm exec vitest run test/thumbnail-frames.test.ts test/thumbnail-generation.test.ts`; confirm failures, implement frame analysis and durable generation/composition. Keep text local and editable; retain source subject pixels/mask by default. Select a production image provider only after verifying its reference-image, edit, output and pricing capabilities at execution time.
- [x] Run focused tests/typecheck and a fixture/local-template rendering test. Paid provider validation is a separate configured integration test. Commit `feat: generate source-grounded thumbnail designs`.

### B6: Thumbnail Studio, downloads and attachment

**Files:** create `components/thumbnails/studio.tsx`, `components/thumbnails/frame-picker.tsx`, `components/thumbnails/variation-grid.tsx`, `components/thumbnails/layer-editor.tsx`, `app/thumbnails/[id]/page.tsx`, `app/api/thumbnails/route.ts`, `app/api/thumbnails/[id]/route.ts`, `app/api/thumbnails/[id]/export/route.ts`, `test/thumbnail-export.test.ts`, `test/e2e/thumbnails.spec.ts`; modify `components/thumbnail-card.tsx`, `components/publish-panel.tsx`, `server/publication-policy.ts`, `server/platforms/youtube.ts` to consume selected package thumbnail instead of guessing a filename.

**Interfaces:** `saveThumbnail(doc: ThumbnailDocument, expectedRevision: number): Promise<ThumbnailDocument>`; `exportThumbnail(id: string, revision: number, options: ThumbnailExportOptions): Promise<ThumbnailExport>`; `attachThumbnail(packageId: string, thumbnailId: string, revision: number): Promise<PublishPackage>`. Export options specify PNG/JPG, one of the three aspect presets and text/no-text. ZIP contains requested variants only.

- [x] Add `edit_text_does_not_regenerate`: change title, color, font, subject position and crop; save/reopen retains edits and provider-call count does not increase. Regenerate one variation/background only when explicitly requested.
- [x] Add `download_outputs_are_real_and_correct`: decode PNG/JPG and assert 1920×1080, 1080×1920 or 1080×1080; verify recomposed layout, text bounds, file signatures and ZIP filenames. Download without accounts; failed regen preserves selected design. Inspect small-size readability with 320 px previews.
- [x] Add `thumbnail_change_invalidates_package`: attaching a new thumbnail revision invalidates old approval, while an unattached downloadable design does not alter the video. Record attached source provenance and actual platform upload result separately from download success.
- [x] Run `pnpm exec vitest run test/thumbnail-export.test.ts test/publication-policy.test.ts`; confirm failures, implement three-variation UI, manual frame picker, layers, presets, version history, download-all and chosen-package attachment. Use the existing frame card as a direct entry for legacy clips.
- [x] Run focused tests, `pnpm exec playwright test test/e2e/thumbnails.spec.ts`, visual export inspection and typecheck. Commit `feat: add editable downloadable thumbnail studio`.

### B7: Motion templates and advanced edit assistance (R5)

**Files:** create `lib/studio/templates.ts`, `lib/studio/retiming.ts`, `src/studio/reframe.ts`, `components/studio/template-browser.tsx`, `components/studio/keyframe-panel.tsx`, `components/studio/voice-recorder.tsx`, `server/studio/edit-suggestions.ts`, `test/studio-templates.test.ts`, `test/studio-retiming.test.ts`, `test/studio-suggestions.test.ts`; modify B1 renderer adapter, B2 operations and B3 caption/audio mapping.

**Interfaces:** `applyTemplate(doc: ProjectDocument, template: EditTemplate): EditResult`; `retimeItem(doc: ProjectDocument, itemId: string, speed: number): EditResult`; `suggestEdits(input: EditSuggestionInput): Promise<EditOperation[]>`. Templates are versioned, parameterized, sandboxed and use local assets/fonts. Suggested edits are validated operations against a base revision, never privileged executable code.

- [x] Add `motion_seeks_repeatably`: template with intro/outro, animated caption/callout and transform keyframes renders the same selected frames when seeking forward, backward and directly. Reject unsupported properties instead of omitting them.
- [x] Add `speed_and_freeze_remap_audio_captions`: 0.5× and 2× playback produce correct durations, pitch-aware audio and new word positions; freeze frame deliberately holds video with an explicit audio policy. Undo restores the original sequence.
- [x] Add `ai_edits_are_reversible_and_bounded`: silence-removal/reframe suggestions affect only selected items, preserve originals, and refuse a changed base revision. Speaker-free clips fall back to user crop/fit. Voice recording requires microphone permission, supports cancellation and creates a new asset only after acceptance.
- [x] Run `pnpm exec vitest run test/studio-templates.test.ts test/studio-retiming.test.ts test/studio-suggestions.test.ts`; confirm failures, then implement templates, keyframes, speed/freeze, beat-marker display, speaker-aware reframe suggestions and voice recording. Rich Hyperframes output depends on B1 adoption; otherwise show it as unavailable while preserving existing edits.
- [x] Run focused tests, add advanced editing steps to `test/e2e/studio-export.spec.ts`, inspect real exports and run typecheck. Commit `feat: add reusable motion templates and edit assistance`.

R1/R2 completion: a user can manually assemble and soundtrack a video, save/reopen and export it, then create and download three frame-grounded thumbnail designs without connecting a posting account. B7 is a later release and is not a prerequisite for those outcomes or reliable unattended production.
