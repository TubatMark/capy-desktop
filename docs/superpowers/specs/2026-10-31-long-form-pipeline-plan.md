# Long-form video pipeline: plan

Status: waiting for the owner's go-ahead. Nothing is built yet.
Updated 2026-10-31 with audience findings and upload timing (Stage 2).

## Key findings

### Disk
- `~/Movies/capy` is 282 GB and 126 GB is free.
- `.worker` holds about 193 GB, grows about 15 GB a day and is never cleaned. The disk could fill in about 8 days.
- `.worker` also has about 47,000 mostly empty folders from poster and watcher ticks.

### Footage
- 126 landscape segments in `work/*.src.mp4`: 97.7 GB, 2.8 hours, about 90 seconds each. The one tested is 1080p60.
- The finished Shorts are vertical with burned-in captions, so the edit uses the landscape segments instead.
- There is no MrBeast footage.

| Creator | Raw landscape footage |
|---|---|
| RAY LIVE | 59 min |
| Kai Cenat Live | 32.5 min |
| Rakai Live | 20.7 min |
| DDG Live | 20.5 min |
| N3ON | 12.7 min |
| IShowSpeed + Live Speedy | 11.5 min |
| Jynxzi Live | 10.6 min |

### YouTube policy
- The [monetization policy](https://support.google.com/youtube/answer/1311392?hl=en) excludes "clips of moments from your favorite show edited together with little or no narrative". A violation can remove monetization from the whole channel.
- Original narration addresses this rule. Copyright claims and strikes are separate and remain a risk.

### Audience (YouTube Analytics, channel lifetime, read 2026-10-31)
- 13,512 views, all Shorts. 6 subscribers. 99.8% of views are from non-subscribers. 87% are on mobile.
- Share of all views: US 22.6%, Philippines 13.7%, UK 6.5%, India 4.6%, Germany 4.2%. About 30% have no country listed.
- Largest group: men 25–34. Men are about 90% of signed-in viewers overall.
- Philippines: men 25–34 47.5%, men 35–44 21.1%, women 25–34 16.5%, women 35–44 14.9%.
- Average percentage viewed: Philippines 53%, US 71%.
- All 1,854 Philippine views fall between Sep 22 and Sep 30. YouTube may hide small country counts later.
- 98% of channel views (13,204) came in those same 9 days. The 42 uploads since Oct 10 peaked at 60 views.
- Weekday totals follow when Shorts were posted, and Friday's total is one spike (Sep 25, 3,618 views). They can't prove the best day.
- There is no long-form data yet.

### Why Shorts views dropped (checked 2026-10-31, cause not yet proven)
- Sep 22–30: 11 uploads, 12,811 Shorts-feed views. Oct 10–29: 36 uploads, 13 Shorts-feed views. Six newer uploads are too recent to judge.
- Ruled out as the main cause: privacy, copyright flags, region or age limits, made-for-kids setting, category, and post spacing. Time of day looks unlikely, because posts across many hours all got no feed traffic.
- Two causes remain, and they overlap: YouTube's Oct 1 original-content change, and the move from manual uploads to capy's API uploads.
- Test: upload one comparable Short manually in YouTube Studio and compare its feed traffic after 72 hours.
- If a manual upload gets feed traffic, fix the upload path. If not, treat it as an originality or channel problem, and don't make long-form public on this channel until that is resolved.
- Stages 0–2 don't depend on this test. Going public in Stage 3 does.

### Posting volume (2026-10-31)
- Shorts: capy makes about 10 clips a day and posts 3, so there is plenty of stock. Current slots are about 11 PM, 4 AM and 9 AM Philippine time, with none in the afternoon. Adding volume won't help while feed traffic is near zero.
- Long-form: new footage is about 13 raw minutes a day across all creators. Daily long videos would mean mixing creators and using weaker clips, so keep the weekend schedule.

## Upload timing

Evidence is weak: outside sources disagree, and their Philippine numbers don't show sample sizes.

| Source | Friday | Saturday | Sunday |
|---|---|---|---|
| [SocialPilot](https://www.socialpilot.co/insights/best-time-to-post-on-youtube) (PHT list) | 11 AM, 4 PM, 9 PM | 9 AM, 1 PM, 6 PM | 9 AM, 1 PM, 6 PM |
| [Spiralytics](https://www.spiralytics.com/blog/best-times-to-post-social-media-philippines/) (credits Postpone) | 12–3 PM | 9–11 AM | 9–11 AM, 5 PM |

Starting slots (US times apply after US clocks change on Nov 1, 2026):

| Slot | Philippine time | US Eastern | Role |
|---|---|---|---|
| A | Saturday 9:00 AM | Friday 8:00 PM | Main slot; both sources agree, and it also hits US Friday evening |
| B | Sunday 9:00 AM | Saturday 8:00 PM | Same reasoning as A |
| C | Friday 4:00 PM | Friday 3:00 AM | Before the Philippine Friday evening; little US overlap |

- Publish up to two videos per weekend, rotating through the slots.
- Name no winner until each slot has at least 3 videos.
- The Analytics API reports I used have no hour-of-day data. Hours come from Studio's "When your viewers are on YouTube" report, once it has enough data, and the owner can change the slots.

## Tools

| Tool | License | Last commit | Decision |
|---|---|---|---|
| FFmpeg 9.0.2 | GPL-3 (Homebrew build) | 2026-10-31 | Use: installed |
| whisper.cpp | MIT | 2026-10-30 | Use: installed |
| Piper (`piper1-gpl`) | GPL-3 | 2026-10-30 | Use for narration: separate local program, not bundled |
| HyperFrames | Apache-2.0 | 2026-10-31 | Hold: only if cards look too plain; pre-1.0 |
| auto-editor | Unlicense | 2026-10-31 | Skip: transcripts find dead air |
| PySceneDetect | BSD-3 | 2026-10-25 | Skip: FFmpeg scene detection should be enough |
| MoviePy | MIT | 2026-08-26 | Skip: adds nothing over FFmpeg |
| MLT | LGPL-2.1 | 2026-10-29 | Skip: unneeded dependency |
| Revideo | MIT | 2026-07-15 | Skip: less active; repo moved |
| Kokoro | Apache-2.0 | Repo updated 2025-08-06 | Skip: not updated in over a year |
| editly | MIT | 2025-02-20 | Skip: looks abandoned |
| Remotion | Custom | 2026-10-31 | Skip: not open source |
| AutoClip, OpenShorts | MIT | 2026-10-31, 2026-10-30 | Skip: long to short, the opposite job |
| highlight-video-maker | MIT | 2026-01-16 | Skip: 1 star |

This Homebrew FFmpeg has `ass`, `xfade` and `loudnorm`, but not `drawtext` or `subtitles`, so cards use ASS.

## Pipeline

1. **Select:** one creator's clips with landscape footage, leaving out blocked clips, overlaps and clips already used in a long video.
2. **Rank:** real views where available, then AI score.
3. **Script:** AI writes the title, countdown order, intro and a line or two per moment.
4. **Narrate:** local voice with Piper.
5. **Edit:** teaser, intro, rank cards, creator credits, cuts on sentence boundaries, dead air trimmed, crossfades, −14 LUFS audio, outro. Each section renders separately so a crash resumes.
6. **Check:** black frames, silence, length, then the existing AI assessor.
7. **Pick the time:** recommend the next open slot, shown in Philippine and US time.
8. **Review:** the owner watches, edits the title and approves. Nothing uploads without approval.
9. **Upload:** Private first with credits and source links, then public at the chosen slot through the existing `publishAt` support. It doesn't use Shorts slots and skips `shortsTitle()`.
10. **Measure:** record views after 48 hours and 7 days, overall and for the Philippines, against each slot.
11. **Free up space:** see below.

### Deletion rules
- Unlocks once YouTube has finished processing and 48 hours have passed with no problem.
- The owner clicks a button showing the exact files and GB. No automatic deletion until uploads have proven reliable.
- Deletes the landscape segments that video used, plus its working files and master. Keeps titles, transcripts and other text data.
- Keeps footage for any unposted Short, plus that Short's file.

## Page

**Long-form**, under "Make" in the sidebar, as a Kanban board:

Draft → In progress → Ready for review → Uploading → Scheduled → Public → Space freed

- Cards show the thumbnail, creator, length, clip count, current step, publish time and GB that can be freed.
- Failed cards stay in their column with the error and Retry.
- No dragging: the worker moves cards, and the owner acts through buttons.
- The page has an audience panel and editable upload slots.

## Build stages

### Stage 0: Disk
Confirm scratch files are safe to remove, add automatic cleanup, and stop the empty-folder build-up. Deleting anything existing needs the owner's OK.

### Stage 1: Board
Data model, page and footage inventory.

### Stage 2: Edit, audience and timing
- Steps 1–6: render one real Kai Cenat test video for the owner to watch.
- Audience panel: country, age and gender from Analytics using the existing read-only permission, refreshed weekly.
- Best-time recommender with the slots above, editable by the owner.
- Results tracking per slot, including Philippine views.

### Stage 3: Upload
Long-form upload path and scheduled publishing, tested without a live upload, then one Private upload with approval.

### Stage 4: Cleanup
The free-up-space button and its rules, tested on throwaway files.

## Working rules
- Build in a separate worktree from `main`. `fix/fresh-uploads` is 19 commits behind it.
- Run tests, `npx tsc --noEmit --incremental false` and a browser check at each stage.
- The project has no integration branch, so ask where to merge. Don't reinstall capy without an OK.

## Defaults the owner can change
- Length: 8–20 minutes; refuse to build without enough footage.
- Format: one creator per video to start.
- Narration: English.
- Channel: current channel for the Private test. Consider a second channel before anything goes public.
