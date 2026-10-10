# Capy automation, editor and AI thumbnails

Status: proposed product and architecture plan; implementation has not started.

**Goal:** Turn selected creators' new videos into editable, publishable Shorts and downloadable professional thumbnails, with reliable background processing and an optional unattended publishing mode.

Inputs: [automation audit](../../audits/2026-10-09-automation-audit.md), the user's request for manual cutting/merging, sounds and a Hyperframes-style editor, and the user's request for AI thumbnail generation from images in generated clips. Scope is planning only. The current source baseline is `2061efb`; recheck before execution.

## Product experience

1. Connect a subscription-reading account and a publishing destination separately. Select creators to watch, or paste a video/import local media.
2. New uploads appear with a status and a reason if skipped. Capy checks source access, readiness, capacity and creator rules, then generates candidate clips.
3. Open any candidate in **Studio**. Keep the AI cut, or split, trim, delete, reorder and combine footage. Add music, effects, voiceover, B-roll, captions, text and visual templates.
4. Open **Thumbnail Studio**. Capy suggests frames from the actual edit, proposes truthful headlines, and generates three distinct designs. Adjust the subject, text and layout, then download or attach a chosen version to the publishing package.
5. Export locally, send for approval, or let an explicitly enabled creator policy schedule passing packages automatically. Uncertain results go to an exception inbox.
6. See what is processing, waiting, scheduled, actually public or failed. Published results feed back into candidate selection and template choices.

Manual editing and thumbnail downloads must work without a connected posting account. A thumbnail should also be generatable from an existing rendered clip without requiring the user to rebuild that clip in Studio.

## Proposed release sequence

| Release | User-visible outcome | Required foundation |
|---|---|---|
| R0 — dependable state | Existing workflow preserves work and enforces consistent publishing rules | Durable state, media revisions, account pinning, recovery |
| R1 — editing workspace | Cut/split/reorder/merge, sound tracks, editable captions, basic overlays, save/reopen/export | Asset library, project timeline, deterministic render contract |
| R2 — AI Thumbnail Studio | Frame suggestions, three polished editable variations, PNG/JPG download | Immutable frame provenance, image provider adapter, local compositor |
| R3 — creator assistant | Subscription import, catch-up monitoring, automatic drafts and creator templates | Reliable worker, capacity control, source readiness |
| R4 — unattended YouTube | Auto-publish eligible revisions, verified delivery, exception inbox and health dashboard | Media checks, durable upload recovery, actual account capability verification |
| R5 — motion and optimization | Rich Hyperframes templates, speaker-aware framing, measured selection improvements | Integration results, stable editor/export, publication analytics |

Instagram and TikTok delivery are separate milestones after R4; preserve existing assisted adapters meanwhile. No dates are promised before the render/integration test and dependency work are measured. Editor/audio work and unattended delivery are the largest workstreams.

## Studio scope

**R1 essentials**

- Start from one AI clip, several clips from one or multiple sources, a manual range in a source video, or local video/audio/images. A merge creates a new project and preserves originals.
- Main footage lane plus overlay, music, sound-effect, voiceover and caption/text lanes. Import audio initially; microphone recording is a later enhancement.
- Split at playhead; trim both ends; drag/reorder; duplicate; delete; ripple delete; merge into one export. Full-source range selection must fetch/proxy the requested range instead of being constrained to the current ±15-second segment.
- Waveforms, frame stepping, snapping, timeline zoom, keyboard shortcuts and clear selection. Space plays, I/O sets a source range, split is an explicit action, and shortcuts do not intercept typing in text fields.
- Music/effects placement, trims, mute/solo, gain in dB, fades, looping and automatic ducking below dialogue. User-imported or explicitly licensed assets only; an integrated commercial music catalog is outside R1.
- Source audio can be detached without deleting its media. Edits keep audio synchronized. Caption words map from source time to project time after cuts and reordering.
- Editable caption text, timing, position, font and safe areas. Crop/fit/blur; basic color presets; image/B-roll overlays; simple titles; cut and crossfade transitions.
- Undo/redo, autosave with a visible saved state, revision history, duplicate project, missing-media relink and crash recovery. Saving must not overwrite a newer revision from another window.
- Export MP4 presets for 9:16, 16:9 and 1:1. Default video: 1080×1920, 30 fps, H.264/AAC. Source normalization must account for variable frame rate, rotation, mixed audio formats and color/HDR inputs; show unsupported inputs explicitly.
- Proxy previews for large sources; originals for final rendering. Both must use the same timeline positions and crop/layout decisions. Keep the existing simple clip editor accessible during rollout.

**R5 enhancements**

Speaker-aware framing, keyframes, animated callouts, branded intro/outro templates, speed changes with pitch-aware audio and caption remapping, freeze frames, silence-removal suggestions, beat markers and voice recording. AI editing commands propose reversible timeline operations and show their scope before applying them. Multi-user collaboration, multicam and a full professional color-grading suite are not initial requirements.

## Thumbnail Studio scope

This is image-assisted design, not a random screenshot or an unrelated text-to-image poster.

**Frame selection:** analyze scene boundaries and select 8–12 distinct candidates where available. Rank sharpness, exposure, subject visibility and expression; reject near-duplicate/black/blurred frames. Support clips without faces. Let the user scrub to any frame. Keep source asset ID, source timestamp and project revision for every frame. When possible, extract a clean frame from the underlying footage before burned-in captions; retain finished-frame selection too.

**Creative generation:** use the clip transcript/title and selected image references to propose three layouts, such as bold subject + headline, editorial composition, and minimal high-contrast composition. Produce background treatment, subject cutout/mask where available, framing, color and short headline suggestions. The default preserves the real subject's identity and expression, and does not invent events, products or claims absent from the clip. If a precise cutout is unavailable, offer a clean framed composition rather than silently changing the person.

**Editable composition:** store background, source subject, masks, accent shapes and typography as layers. The image model creates/edits visual assets; local composition draws text sharply as an editable layer. Users can change text, font, colors, crop, subject size/position, outline/shadow, logo and layout without another generation call. Offer regenerate-one-variation, regenerate-background and replace-source-frame actions, each with clear cost/status.

**Outputs:** one-click PNG/JPG downloads; 1920×1080 landscape, 1080×1920 portrait and 1080×1080 square presets; actual recomposition for each aspect ratio rather than stretching. Keep text inside configurable safe margins and show a small-size preview. Include text-free export, download-all ZIP, named versions and optional attachment to the publishing package. Export dimensions/file-size checks follow the selected destination's current limits; the download feature does not depend on platform upload eligibility.

**Generation modes:** manual by default, or an explicit creator setting to generate automatically after the final edit. Default batch is three designs in one selected aspect ratio; other sizes are rendered on demand. Record the provider, model, source references, prompt, cost where reported, and output assets. Set per-job/day budgets and retry limits. Failure leaves the video intact; if that creator's publishing policy requires an approved thumbnail, publishing waits. Otherwise the user-configured fallback can use a source frame.

**Versions and quality:** thumbnails reference the exact video/project revision. Changing the footage marks the thumbnail stale but preserves its downloadable versions. A changed thumbnail attached to an approved package invalidates that package approval. Check spelling, text overflow, readability at 320 px width, subject visibility, actual source provenance and misleading claims. “Enticing” is a design objective, not a promised click-through-rate improvement.

The existing six-frame picker in `src/pipeline.ts` and `components/thumbnail-card.tsx` remains a fast/free path. AI image generation is a separate capability from the current text-agent abstraction; do not assume a Claude/Codex CLI login provides an image API. Implement a provider adapter and retain a local template fallback. No provider subscription or paid generation is initiated by this plan.

## Task-specific AI routing and cost discipline

User requirement: use sensible models; do not use an oversized model for a simple task. The default is **Economical**, meaning the least expensive evaluated option that meets the task's quality requirements. This does not mean silently accepting lower quality for required reviews.

| Process | Default execution | Escalation rule |
|---|---|---|
| Discovery, deduplication, technical media checks, scheduling, uploading | Deterministic code; no language model | None |
| Cuts, merges, gain/fades, captions placement, image resizing/text layout | Timeline operations and local rendering; no language model | AI only for an explicitly requested creative suggestion |
| Transcription | Existing captions when adequate; local speech recognition otherwise | Cloud speech only when configured and local output fails measured checks |
| Titles, descriptions, short headlines, topic tags | Small/fast text model; batch related fields | One bounded retry for schema/length problems; no automatic flagship upgrade |
| Translation | Small multilingual model evaluated for the language pair; process relevant segments | Configured mid-tier model for failed adequacy checks, otherwise review queue |
| Clip selection | Mid-tier text model on transcript with timestamps; chunk long transcripts | Larger model only for a flagged difficult case under an explicit escalation policy |
| Content review | Separate compact-model pass calibrated on representative clips | Ambiguity escalates once to the configured reviewer or waits for a person; never fail open |
| Frame ranking and visual checks | Local sharpness/exposure/duplicate checks first; compact vision model on a small shortlist | Higher-capability vision only for unresolved cases and within budget |
| Thumbnail generation | Reference-image-capable image model at standard quality; local templates/text composition | Premium quality is opt-in; editing text/layout never triggers another image call |
| Editing assistance | Small model for bounded structured edit requests; mid-tier for complex multi-step requests | Validate every proposed operation; unsupported requests wait for user correction |
| Performance summaries | Deterministic aggregates; optional small-model explanation | No model call for routine metric refresh |

Settings expose a provider/model assignment per task, capability validation, timeout, input/output limits, retry limit, fallback, local/cloud permission and per-job/day budgets. Optional creator overrides inherit global limits and cannot silently increase them. Offer Economical and Balanced presets; premium task upgrades are explicit. Choose exact model IDs after checking current capabilities/pricing and evaluating representative content, rather than hardcoding today's flagship everywhere.

Use task-specific context: titles need the selected clip, not the entire source transcript; vision needs selected frames, not every frame. Reuse transcripts, translations and briefs. Cache by input hash, prompt/schema version, provider/model and parameters; invalidate when relevant media/text changes. A retry or escalation spends from the same job/day budget. Default: at most one retry and one configured escalation, with no recursive fallback chain.

Store task, actual model/version, reason for routing/escalation, latency and reported usage/cost. Label estimates as estimates; unknown pricing is not zero cost. Subscription-backed calls still need usage/rate limits. Model self-confidence alone is not an escalation or approval test; use schema checks, technical checks and a labeled evaluation set. No routine multi-model voting or repeated whole-video analysis.

## Architecture decisions

- **Keep:** Electron, Next.js/React UI, existing source/transcript/pick logic, ffmpeg, platform adapters and existing media files.
- **Durable state:** SQLite locally, owned through one repository layer with transactions, WAL, versioned migrations and backups. Execution selects and pins a SQLite driver that passes the actual Node and packaged Electron runtime tests. Media stays on disk, indexed by stable asset IDs/checksums. Copy/import legacy JSON non-destructively, reconcile counts and leave rollback backups.
- **Canonical edit model:** a typed, versioned project document, not arbitrary generated HTML. Timeline positions are integer project frames at a rational frame rate; source ranges use integer microseconds. Media items have stable source IDs, range, track, placement and render properties. Preserve source time mapping through edits.
- **Canonical publishing package:** immutable references to project revision, media checksum, posting text, selected thumbnail revision, destination account ID and review/policy version. Central eligibility applies to approval, move, post-now, retry and actual upload.
- **Worker:** separate supervised execution from the Next request lifecycle. Durable jobs have checkpoints, lease owner, fencing generation, heartbeat, retry time, cancellation and bounded subprocess deadlines. An always-awake Mac is the first worker target. A remote worker is required if work must continue while the Mac is off/asleep; that is a deployment choice, not something a tray timer solves.
- **Hyperframes:** evaluate its embeddable Studio/player/producer for preview, motion composition and rendering. Gate adoption on edit round-tripping, audio sync, deterministic seek/export, current React/Next compatibility, resource use, package/license review and an offline packaged Electron test. If it fails, keep the canonical model and ffmpeg renderer, and defer rich motion while shipping the basic editor. Do not maintain independent editable HTML and project JSON sources of truth.
- **Preview/render:** compile the same project revision into preview and export plans. Persist assets/fonts locally. If a feature cannot be represented by an active renderer, reject it visibly; do not silently drop it. Use sandboxed templates and a validated message bridge, not arbitrary AI-produced scripts with application privileges.
- **Always-on detection:** subscription import plus paginated reconciliation first; a small public WebSub receiver later for faster events. That receiver stores validated events and never exposes the local app API or credentials. Worker connections are authenticated.

## Automation rules and delivery

Per creator: enabled status, permitted source method, minimum/maximum duration, include/exclude topics, live/Shorts policy, language, clip count, quality threshold, edit/thumbnail template, destination IDs, daily/budget caps, freshness and review mode. Modes are **manual**, **automatic drafts**, and **automatic publish**. Automatic publishing stays off until explicitly enabled and the release gates pass.

Generate only as much as the publication calendar can absorb. Start with a three-day target queue, a seven-day maximum unpublished backlog, and a configurable 72-hour freshness limit for new source candidates; these are proposed product defaults, not platform rules. Pause expensive work at capacity, retain skip/defer reasons, prevent clipping destination channels recursively, and provide explicit backfill controls.

Quality gates check decoded media, duration/aspect, audio, black/frozen frames, caption safe areas, review freshness, selected destination and source permissions. Model uncertainty, provider unavailability and budget exhaustion must produce visible waiting states. Avoid equating an AI score with content rights or platform acceptance.

Persist upload session identifiers before transfer where supported. Reconcile ambiguous outcomes before retrying. Distinguish uploaded, processing, scheduled, public, needs-action and delivery-unknown. Upload ahead and use platform scheduling where verified. Track platform quotas separately from AI/render budgets. Revalidate current platform capabilities when connecting and before introducing unattended publishing.

## Release proof

- Preserve legacy jobs, edits, media and queued items through migration/rollback; never auto-enable inherited automation.
- Mixed-source edit: split, remove a middle segment, reorder, merge, add music/effects, change captions, undo/redo, reopen, export. Cuts and captions within one output frame; no measurable cumulative audio drift beyond one frame across a 60-second fixture.
- Thumbnail: generated from actual clip frames; three persisted designs; editable text without regeneration; landscape/portrait/square exports with correct dimensions and no overflow; original version survives a failed regeneration.
- Discovery: paginated subscriptions, more than 12 missed uploads, repeated/edit events, premieres, deleted/private videos, revoked access and own-channel exclusions.
- Delivery: crash before/after remote acceptance, expired tokens, destination switch, changed media/thumbnail/text after approval, stale worker and full disk. No blind duplicate upload or silent destination change.
- At least a 72-hour fault-injected worker soak, followed by a separately authorized controlled publishing test with confirmed remote processing, scheduling and visibility.

## References checked for this plan

Hyperframes documents an [embeddable Studio](https://hyperframes.app/docs/5-packages/studio), [player](https://hyperframes.app/docs/5-packages/player) and [producer](https://hyperframes.app/docs/5-packages/producer). These support evaluating reuse; they do not prove Capy's integration or editing requirements.

YouTube now describes custom Shorts thumbnail uploads rolling out initially to YPP creators, with suggested-frame selection as another route. Downloading a design must always work; uploading it should reflect actual account/platform support, and an API upload path needs separate verification. [YouTube announcement](https://blog.youtube/news-and-events/youtube-studio-custom-thumbnail-updates/), [thumbnail help](https://support.google.com/youtube/answer/72431?hl=en).

Platform policy and quota findings remain in the audit; revalidate them during implementation. The plan does not promise universal public auto-posting across all three platforms.
