# Story plan, assessor and To do — design

Date: 2026-10-06. Phase 2 of "plan for reach" (phase 1: `2026-10-06-channel-seo-design.md`).

## What the user asked for

Every kids story is planned for reach at the brief (hook, title, keywords, structure), shown as gauges. A separate
worker assesses the plan and the content before anything is handed to the user, and then gives the user their
to-dos (review this, queue that). Make sure it's right before it reaches them.

Honest framing for made-for-kids content: no comments, no bell, narrower recommendations. Reach comes from
**search** (what parents type), **the first two seconds** (does the feed scroll past), **replays** (kids rewatch),
and a **series** parents come back to. The plan optimises those, never by aiming persuasion at children.

## 1. The plan — `src/story/plan.ts`

`createStory` now plans before it writes (the story shows "Planning…", then "Writing…"):

1. Keyword research for the brief (phase 1's `seedPhrases` + `research`, kids audience).
2. The AI planner returns `StoryPlan`:
   - `keyword` (what parents search) and 3–6 `searchTerms`;
   - `title` (searchable, warm, for parents: e.g. "Pip Learns to Share | Bedtime Story for Toddlers");
   - `hook`: the first page's opening line and its picture, a striking, warm image that works as the cover;
   - `beats`: setup, problem, turn, ending; the ending invites a replay (a callback to the opening, a refrain);
   - `refrain` (optional, ages 2–4: a repeated line kids join in on);
   - `pages` and `targetSeconds` (30–60 s);
   - `parentsWhy`: one line on why a parent would pick and replay it.
3. The writer receives the plan: the title, page 1 = the hook, the beats, the refrain. The keyword goes in the
   title and upload text, never stuffed into the story's words.

Rewrite keeps the plan. If planning fails, the story is written from the brief alone (plan missing, noted in log).

## 2. The assessor — `src/story/assess.ts` + `server/assessor.ts`

A separate worker (its own queue, one assessment at a time) that StoryManager notifies after three stages:

- **script**: after the kid-safety reviewer;
- **video**: after render + SEO + content review;
- (the plan is assessed as part of **script**, since a plan alone has no words to judge).

`StoryAssessment = { stage, at, overall, scores: { hook, retention, search, safety, production }, verdict, strengths, fixes }`:

- `hook`, `retention`: AI judgement (0–100 each) with notes: does page 1 stop the scroll and promise a story;
  does each page move; is there repetition/refrain for little ones; does the ending invite a replay.
- `search`: `scoreSeo` of the plan title + keyword (script stage) or the final upload text (video stage).
- `safety`: from the kid-safety reviewer (ok 100, fix 60, block 0) and, at video stage, the content review
  (ok 100, caution 60, block 0); the lower of the two.
- `production`: deterministic: page count in the age band's range, words per page within the limit, at video
  stage the length within 25–65 s and every page drawn.
- `overall`: weighted (hook 25, retention 25, search 20, safety 20, production 10); `verdict`: `block` if safety is
  0, `ready` if overall ≥ 75 and safety ≥ 80, else `fix`.

Assessments are kept on the story (`assessments.script`, `assessments.video`); a new stage run replaces that stage.
Edits that change the words clear the script assessment; a new render clears the video one. An assessor failure
leaves the stage "not assessed" with the reason, and a **Check again** button.

## 3. To do — `server/tasks.ts`, `/todo`

Tasks are derived (not stored) from the stories and the queue, so they are always current:

- A story's script waits for you **only once the assessor has assessed it**: "Review the script of X" (verdict,
  top fixes). A blocked one: "Rewrite X: …".
- Pictures done: "Make the video for X".
- Video done and assessed: "Watch X and send it to Queue" (ready) or "Fix X before it goes out" (fix).
- Queue: "Approve N videos waiting in Queue".
- Errors: "X needs attention".

Each task links where to act. Sidebar **To do** shows the count. The Stories studio shows the plan card and the
assessment gauges (Overall, Hook, Retention, Search, Kid-safe) with strengths and fixes, and "Fix these with AI"
at script stage (a rewrite with the assessor's fixes).

## Testing

Pure: plan normalisation, writer prompt includes the plan, production scoring, overall/verdict, safety mapping,
task derivation. Manager: plan → write → review → assess order with fakes; assessor queue runs one at a time and
survives failures; edits clear assessments. Routes: `/api/todo`, the assess-again action.
