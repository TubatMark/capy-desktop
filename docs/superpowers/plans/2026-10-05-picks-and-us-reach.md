# Better Picks and US Reach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed YouTube's "Most replayed" heatmap into the picker, add an English (US) audience mode with phrase-synced English captions for non-English videos, and add a separate reviewer pass with a per-clip Replace button.

**Architecture:** The new logic goes into small, focused modules: `src/heatmap.ts`, `src/lang.ts`, `src/translate.ts` and `src/review.ts`. Each has pure helpers that are unit-tested, plus one AI call that goes through the existing `askAgent`. `server/jobs.ts` wires them into the analyze flow (pick → review → segments → translate) and adds `replaceClip` and `translateClip`. The UI gets badges, reviewer notes and a Replace popover on `PickCard`, an audience select in the URL form and Settings, and English caption words in the editor preview.

**Tech Stack:** TypeScript, Next.js 16 App Router (route handlers), zod 4 (`z.toJSONSchema`), vitest, yt-dlp JSON, existing `askAgent` (Claude Agent SDK or other CLIs).

**Spec:** `docs/superpowers/specs/2026-10-05-picks-and-us-reach-design.md`

## Global Constraints

- Audience values are exactly `"original" | "en-us"`. The app default is `"en-us"`.
- An unknown source language counts as English, so nothing is translated.
- Phrase split: sentence punctuation, gap > 0.6 s, or 4 s maximum. Spread words: proportional to character count, at least 0.12 s each.
- The picker asks for `count + 2`, and `applyReview` ticks at most `count`.
- "Most replayed" badge when `replayPeak >= 0.7`. Peak threshold `minValue = 0.5`, at most 8 peaks.
- The reviewer or translator failing never fails picking. It logs, then falls back.
- Replace returns 409 while the clip is rendering or rendered, and 400 when nothing new is found.
- UI copy says "AI", not "Claude" (project memory rule). Nothing Mac-only in user-facing copy.
- Follow the repo idioms: zod schemas → `z.toJSONSchema(..., { target: "draft-7" })` with `$schema` stripped; `askAgent(agent, prompt, {model, maxTurns, effort, system, schema})`; route handlers call `jobs()` and return `NextResponse.json`.

## Review Focus

1. **Overlong heatmap ranges.** If every bucket is above 0.5 (a flat, popular video), the merged peak would cover the whole video. Expect ranges no longer than 90 s (split long runs) and the top 8 by value. Test in Task 1.
2. **Translation returns a different number of phrases or empty strings.** Expect missing indices to keep the original text and empty `en` to keep the original. Test in Task 3.
3. **A phrase too short for its words.** Many English words in a 0.3 s phrase must not produce overlapping or reversed times. Expect the span to stretch until the next phrase's start (or the end), and words stay ordered. Test in Task 3.
4. **The reviewer returns unknown `n` values or duplicates.** Expect them ignored, with clips not mentioned treated as `pass`. Test in Task 4.
5. **Replace when every other part of the video is already picked.** Expect a 400 with "No other good moment found", and the clip unchanged. Covered by the `pickClips` empty-result path in Task 6.

---

### Task 1: Heatmap peaks

**Files:**
- Create: `src/heatmap.ts`
- Modify: `src/types.ts` (VideoMeta), `src/youtube.ts:37-50` (fetchMeta)
- Test: `test/heatmap.test.ts`

**Interfaces:**
- Produces: `type HeatPoint = { start: number; end: number; value: number }`; `replayPeaks(heat: HeatPoint[] | undefined, o?: { minValue?: number; max?: number; maxLen?: number }): HeatPoint[]`; `peakFor(peaks: HeatPoint[], start: number, end: number): number | undefined` (highest overlapping value); `fmtPeaks(peaks: HeatPoint[]): string` (lines like `12:40–13:10 (100%)`); `VideoMeta.heatmap?: HeatPoint[]`.

- [ ] **Step 1: Write the failing test** `test/heatmap.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fmtPeaks, peakFor, replayPeaks } from "../src/heatmap";

const h = (vals: number[], step = 10) => vals.map((value, i) => ({ start: i * step, end: (i + 1) * step, value }));

describe("replayPeaks", () => {
  it("returns [] for missing or empty heatmaps", () => {
    expect(replayPeaks(undefined)).toEqual([]);
    expect(replayPeaks([])).toEqual([]);
  });
  it("merges adjacent buckets above the threshold and keeps the max value", () => {
    const p = replayPeaks(h([0.1, 0.6, 0.9, 0.2, 0.55, 0.1]));
    expect(p).toEqual([
      { start: 10, end: 30, value: 0.9 },
      { start: 40, end: 50, value: 0.55 },
    ]);
  });
  it("sorts by value and caps the count", () => {
    const p = replayPeaks(h([0.6, 0, 0.8, 0, 0.7, 0, 0.9]), { max: 2 });
    expect(p.map((x) => x.value)).toEqual([0.9, 0.8]);
  });
  it("splits runs longer than maxLen so a flat popular video doesn't become one giant peak", () => {
    const p = replayPeaks(h(Array(30).fill(0.8)), { maxLen: 90 });
    expect(p.every((x) => x.end - x.start <= 90)).toBe(true);
    expect(p.length).toBeGreaterThan(1);
  });
});

describe("peakFor / fmtPeaks", () => {
  const peaks = [{ start: 100, end: 130, value: 1 }, { start: 300, end: 310, value: 0.6 }];
  it("returns the highest overlapping peak value", () => {
    expect(peakFor(peaks, 120, 160)).toBe(1);
    expect(peakFor(peaks, 200, 250)).toBeUndefined();
  });
  it("formats mm:ss ranges with percent", () => {
    expect(fmtPeaks(peaks)).toBe("1:40–2:10 (100%)\n5:00–5:10 (60%)");
  });
});
```

- [ ] **Step 2: Run it.** `pnpm vitest run test/heatmap.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/heatmap.ts`

```ts
/** One bucket of YouTube's "Most replayed" graph (yt-dlp `heatmap`), value 0..1. */
export interface HeatPoint {
  start: number;
  end: number;
  value: number;
}

/** Merge adjacent buckets at or above `minValue` into ranges (split past `maxLen` s), strongest first. */
export function replayPeaks(heat: HeatPoint[] | undefined, o: { minValue?: number; max?: number; maxLen?: number } = {}): HeatPoint[] {
  const { minValue = 0.5, max = 8, maxLen = 90 } = o;
  const out: HeatPoint[] = [];
  let cur: HeatPoint | null = null;
  for (const p of [...(heat ?? [])].sort((a, b) => a.start - b.start)) {
    const hot = p.value >= minValue;
    if (hot && cur && p.start - cur.end < 0.5 && p.end - cur.start <= maxLen) {
      cur.end = p.end;
      cur.value = Math.max(cur.value, p.value);
      continue;
    }
    if (cur) out.push(cur);
    cur = hot ? { ...p } : null;
  }
  if (cur) out.push(cur);
  return out.sort((a, b) => b.value - a.value).slice(0, max);
}

/** Highest peak value overlapping [start, end), if any. */
export function peakFor(peaks: HeatPoint[], start: number, end: number): number | undefined {
  let best: number | undefined;
  for (const p of peaks) if (p.start < end && p.end > start) best = Math.max(best ?? 0, p.value);
  return best;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function fmtPeaks(peaks: HeatPoint[]): string {
  return peaks.map((p) => `${mmss(p.start)}–${mmss(p.end)} (${Math.round(p.value * 100)}%)`).join("\n");
}
```

- [ ] **Step 4: Add the field.** In `src/types.ts`, add `heatmap?: { start: number; end: number; value: number }[];` to `VideoMeta` (with a doc comment `"Most replayed" buckets from yt-dlp, value 0..1`). In `fetchMeta`, add:

```ts
    heatmap: Array.isArray(j.heatmap)
      ? j.heatmap.map((p: { start_time: number; end_time: number; value: number }) => ({ start: p.start_time, end: p.end_time, value: p.value }))
      : undefined,
```

- [ ] **Step 5: Run it.** `pnpm vitest run test/heatmap.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add src/heatmap.ts src/types.ts src/youtube.ts test/heatmap.test.ts && git commit -m "Picker: read YouTube Most-replayed heatmap into replay peaks"`

---

### Task 2: Language helper and prompt sections (peaks, en-us, replace)

**Files:**
- Create: `src/lang.ts`
- Modify: `src/pick.ts` (PickOpts, buildPrompt, rewriteTitleHook, generatePublish)
- Test: `test/lang.test.ts`, `test/pick-prompt.test.ts`

**Interfaces:**
- Consumes: `HeatPoint`, `fmtPeaks` (Task 1).
- Produces:
  - `type Audience = "original" | "en-us"` (in `lib/types.ts`, see Task 5; declared here first and re-exported)
  - `isEnglish(lang?: string): boolean` (true for undefined)
  - `PickOpts` gains `peaks?: HeatPoint[]`, `audience?: Audience`, `replace?: { start: number; end: number; reason: string; avoid: { start: number; end: number }[] }`
  - `languageRule(audience?: Audience): string`
  - `rewriteTitleHook(..., agent, audience?)` and `generatePublish(..., agent, audience?)` take a trailing optional `audience`.

- [ ] **Step 1: Add the type.** Add to `lib/types.ts` (needed now, used everywhere later): `export type Audience = "original" | "en-us";`

- [ ] **Step 2: Write the failing tests**

`test/lang.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isEnglish } from "../src/lang";

describe("isEnglish", () => {
  it.each([[undefined, true], ["en", true], ["en-US", true], ["en-orig", true], ["en_GB", true], ["pt-BR", false], ["pt", false], ["es-orig", false], ["eng", false]])("%s → %s", (l, want) => {
    expect(isEnglish(l as string | undefined)).toBe(want);
  });
});
```

`test/pick-prompt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/pick";

const meta = { title: "Ep 1", duration: 3600, channel: "Mia" };
const base = { count: 6, minSec: 20, maxSec: 60 };

describe("buildPrompt", () => {
  it("has no peaks section without peaks, and keeps the speakers' language for original", () => {
    const p = buildPrompt("[0] hi", meta, { ...base, audience: "original" });
    expect(p).not.toContain("Viewer replay peaks");
    expect(p).toContain("same language the speakers use");
  });
  it("adds the replay peaks section", () => {
    const p = buildPrompt("[0] hi", meta, { ...base, peaks: [{ start: 100, end: 130, value: 1 }] });
    expect(p).toContain("Viewer replay peaks");
    expect(p).toContain("1:40–2:10 (100%)");
  });
  it("switches text to US English for en-us", () => {
    const p = buildPrompt("[0] hi", meta, { ...base, audience: "en-us" });
    expect(p).toContain("natural US English");
    expect(p).not.toContain("same language the speakers use");
  });
  it("adds the replace section with the rejection reason and ranges to avoid", () => {
    const p = buildPrompt("[0] hi", meta, { ...base, count: 1, replace: { start: 190, end: 230, reason: "ends before the payoff", avoid: [{ start: 10, end: 40 }] } });
    expect(p).toContain("3:10–3:50 was rejected because: ends before the payoff");
    expect(p).toContain("0:10–0:40");
  });
});
```

- [ ] **Step 3: Run them.** `pnpm vitest run test/lang.test.ts test/pick-prompt.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement** `src/lang.ts`

```ts
/** True when a language code is English, or unknown (unknown is treated as English: nothing gets translated). */
export function isEnglish(lang?: string): boolean {
  if (!lang) return true;
  return /^en($|[-_])/i.test(lang);
}
```

- [ ] **Step 5: Update `src/pick.ts`**
  - Import `type HeatPoint, fmtPeaks` from `./heatmap` and `type Audience` from `../lib/types`. Add the three new optional fields to `PickOpts` (with doc comments).
  - Add:

```ts
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What language the title/hook/upload text is written in. */
export function languageRule(audience?: Audience): string {
  return audience === "en-us"
    ? "Write title, hook, ytTitle, description and hashtags in natural US English for American viewers, even when the speakers use another language. Avoid moments that only work with local cultural context the hook can't explain. Prefer hashtags US viewers search for."
    : "title and hook in the same language the speakers use.";
}
```

  - In `buildPrompt`, replace the line `- title and hook in the same language the speakers use.` with `- ${languageRule(o.audience)}`. Before `${o.focus ? …}`, insert:

```ts
${o.replace ? `- Find a different moment. The previous pick at ${mmss(o.replace.start)}–${mmss(o.replace.end)} was rejected because: ${o.replace.reason}. Avoid that problem. Do not overlap these ranges: ${[o.replace, ...o.replace.avoid].map((r) => `${mmss(r.start)}–${mmss(r.end)}`).join(", ")}.\n` : ""}
```

    After the rules block and before `Transcript:`, insert:

```ts
${o.peaks?.length ? `Viewer replay peaks (the parts viewers rewound to most: a strong signal of a great moment; prefer clips that contain one, but each clip must still be self-contained):\n${fmtPeaks(o.peaks)}\n\n` : ""}
```

  - `rewriteTitleHook` and `generatePublish`: add a trailing param `audience?: Audience` and replace their final `Same language as the speakers.` line with `${audience === "en-us" ? "Write in natural US English for American viewers." : "Same language as the speakers."}`.

- [ ] **Step 6: Run it.** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 7: Commit.** `git add lib/types.ts src/pick.ts src/lang.ts test/lang.test.ts test/pick-prompt.test.ts && git commit -m "Picker: replay-peak, US-English and replace sections in the prompt"`

---

### Task 3: Caption translation core

**Files:**
- Create: `src/translate.ts`
- Test: `test/translate.test.ts`

**Interfaces:**
- Consumes: `Word` (`src/types.ts`), `askAgent` (`src/agents.ts`), `AgentId` (`lib/types.ts`).
- Produces:
  - `interface Phrase { i: number; start: number; end: number; text: string }`
  - `splitPhrases(words: Word[], start: number, end: number): Phrase[]`
  - `spreadWords(phrase: Phrase, en: string, nextStart?: number): Word[]`
  - `applyTranslations(phrases: Phrase[], got: { i: number; en: string }[]): Word[]`
  - `mergeWords(existing: Word[], add: Word[], range: { start: number; end: number }): Word[]`
  - `translateRange(words: Word[], range: { start: number; end: number }, sourceLang: string | undefined, o: { agent: AgentId; model?: string }): Promise<Word[]>`

- [ ] **Step 1: Write the failing test** `test/translate.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { applyTranslations, mergeWords, splitPhrases, spreadWords } from "../src/translate";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("splitPhrases", () => {
  it("cuts at sentence punctuation", () => {
    const p = splitPhrases([w("Oi,", 0, 0.3), w("tudo", 0.3, 0.6), w("bem?", 0.6, 1), w("Sim.", 1.1, 1.5)], 0, 10);
    expect(p.map((x) => x.text)).toEqual(["Oi, tudo bem?", "Sim."]);
    expect(p[0]).toMatchObject({ i: 0, start: 0, end: 1 });
  });
  it("cuts at gaps over 0.6s and at 4s", () => {
    const long = Array.from({ length: 12 }, (_, k) => w(`w${k}`, k * 0.5, k * 0.5 + 0.4));
    const p = splitPhrases([w("a", 0, 0.2), w("b", 1, 1.2), ...long.map((x) => ({ ...x, start: x.start + 2, end: x.end + 2 }))], 0, 20);
    expect(p[0]!.text).toBe("a");
    expect(p.every((x) => x.end - x.start <= 4.01)).toBe(true);
  });
  it("only uses words starting inside the range", () => {
    expect(splitPhrases([w("x", 0, 1), w("y.", 5, 6)], 4, 10).map((x) => x.text)).toEqual(["y."]);
  });
});

describe("spreadWords", () => {
  it("spreads words over the phrase by length, ordered and inside the span", () => {
    const out = spreadWords({ i: 0, start: 10, end: 12, text: "x" }, "I can't believe it");
    expect(out.map((x) => x.text)).toEqual(["I", "can't", "believe", "it"]);
    expect(out[0]!.start).toBe(10);
    expect(out.at(-1)!.end).toBeCloseTo(12);
    for (let k = 1; k < out.length; k++) expect(out[k]!.start).toBeGreaterThanOrEqual(out[k - 1]!.end - 1e-9);
  });
  it("stretches a too-short phrase toward the next phrase so words keep 0.12s", () => {
    const out = spreadWords({ i: 0, start: 5, end: 5.2, text: "x" }, "one two three four", 6);
    expect(out.every((x) => x.end - x.start >= 0.12 - 1e-9)).toBe(true);
    expect(out.at(-1)!.end).toBeLessThanOrEqual(6);
  });
});

describe("applyTranslations", () => {
  const phrases = [{ i: 0, start: 0, end: 1, text: "Oi." }, { i: 1, start: 1, end: 2, text: "Tchau." }];
  it("keeps the original text for missing or empty translations", () => {
    const out = applyTranslations(phrases, [{ i: 0, en: "Hi." }, { i: 1, en: "  " }, { i: 7, en: "junk" }]);
    expect(out.map((x) => x.text)).toEqual(["Hi.", "Tchau."]);
  });
});

describe("mergeWords", () => {
  it("replaces words inside the range and keeps the rest sorted", () => {
    const out = mergeWords([w("a", 0, 1), w("b", 5, 6), w("c", 20, 21)], [w("B", 5, 5.5), w("B2", 5.5, 6)], { start: 4, end: 10 });
    expect(out.map((x) => x.text)).toEqual(["a", "B", "B2", "c"]);
  });
});
```

- [ ] **Step 2: Run it.** `pnpm vitest run test/translate.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `src/translate.ts`

```ts
import { z } from "zod";
import type { Word } from "./types";
import { askAgent } from "./agents";
import type { AgentId } from "../lib/types";

/** A run of spoken words shown as one translated caption line. Times are in source-video seconds. */
export interface Phrase {
  i: number;
  start: number;
  end: number;
  text: string;
}

const MAX_PHRASE = 4;
const MAX_GAP = 0.6;
const MIN_WORD = 0.12;

/** Split the words starting in [start, end) into phrases: at sentence punctuation, gaps over 0.6s, or 4s. */
export function splitPhrases(words: Word[], start: number, end: number): Phrase[] {
  const out: Phrase[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ i: out.length, start: cur[0]!.start, end: cur.at(-1)!.end, text: cur.map((x) => x.text).join(" ") });
    cur = [];
  };
  for (const w of words) {
    if (w.start < start || w.start >= end) continue;
    const prev = cur.at(-1);
    if (prev && (w.start - prev.end > MAX_GAP || w.end - cur[0]!.start > MAX_PHRASE)) flush();
    cur.push(w);
    if (/[.!?…]["')\]]*$/.test(w.text)) flush();
  }
  flush();
  return out;
}

/** English words for one phrase, timed across its span by character count (each at least 0.12s). */
export function spreadWords(phrase: Phrase, en: string, nextStart?: number): Word[] {
  const parts = en.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const need = parts.length * MIN_WORD;
  let end = phrase.end;
  if (end - phrase.start < need) end = Math.min(phrase.start + need, nextStart ?? phrase.start + need);
  const span = Math.max(end - phrase.start, 0.01);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out: Word[] = [];
  let t = phrase.start;
  parts.forEach((text, k) => {
    const share = k === parts.length - 1 ? end - t : (span * text.length) / total;
    const e = k === parts.length - 1 ? end : Math.min(end, t + share);
    out.push({ text, start: t, end: e });
    t = e;
  });
  return out;
}

/** Translated phrases → timed English words. Missing or empty translations keep the original text. */
export function applyTranslations(phrases: Phrase[], got: { i: number; en: string }[]): Word[] {
  const byI = new Map(got.filter((g) => g.en?.trim()).map((g) => [g.i, g.en.trim()]));
  return phrases.flatMap((p, k) => spreadWords(p, byI.get(p.i) ?? p.text, phrases[k + 1]?.start));
}

/** Replace the words of `existing` that start inside `range` with `add`; keep everything sorted by start. */
export function mergeWords(existing: Word[], add: Word[], range: { start: number; end: number }): Word[] {
  return [...existing.filter((w) => w.start < range.start || w.start >= range.end), ...add].sort((a, b) => a.start - b.start);
}

const TranslationSchema = z.object({ phrases: z.array(z.object({ i: z.number(), en: z.string() })) });

/** Translate the spoken words in `range` to US English caption words (one AI call, retried once for missing lines). */
export async function translateRange(
  words: Word[],
  range: { start: number; end: number },
  sourceLang: string | undefined,
  o: { agent: AgentId; model?: string },
): Promise<Word[]> {
  const phrases = splitPhrases(words, range.start, range.end);
  if (!phrases.length) return [];
  const { $schema: _d, ...schema } = z.toJSONSchema(TranslationSchema, { target: "draft-7" }) as Record<string, unknown>;
  const ask = async (list: Phrase[]) => {
    const res = await askAgent(o.agent, `Translate each spoken caption line${sourceLang ? ` (language: ${sourceLang})` : ""} to natural, spoken US English for vertical-video captions. Keep it short and casual, one line in, one line out, same index. Do not merge or split lines.\n\n${JSON.stringify(list.map((p) => ({ i: p.i, text: p.text })))}`, {
      model: o.model,
      maxTurns: 2,
      effort: "low",
      system: "You translate video captions. Answer only with the requested JSON.",
      schema,
    });
    const parsed = TranslationSchema.safeParse(res.data);
    if (!parsed.success) throw new Error(`Translation output failed validation: ${parsed.error.message}`);
    return parsed.data.phrases;
  };
  let got = await ask(phrases);
  const missing = phrases.filter((p) => !got.some((g) => g.i === p.i && g.en.trim()));
  if (missing.length) got = [...got, ...(await ask(missing).catch(() => []))];
  return applyTranslations(phrases, got);
}
```

- [ ] **Step 4: Run it.** `pnpm vitest run test/translate.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/translate.ts test/translate.test.ts && git commit -m "Captions: phrase-synced English translation core"`

---

### Task 4: Reviewer core

**Files:**
- Create: `src/review.ts`
- Modify: `lib/types.ts` (ClipState.review)
- Test: `test/review.test.ts`

**Interfaces:**
- Consumes: `askAgent`, `Word`, `Clip`, `Audience`.
- Produces:
  - `type ReviewVerdict = "pass" | "fix_hook" | "fail"`
  - `interface ReviewItem { n: number; verdict: ReviewVerdict; problem?: string; title?: string; hook?: string }`
  - `reviewPicks(words: Word[], meta: { title: string; channel?: string }, clips: (Clip & { n: number })[], o: { audience?: Audience; agent: AgentId; model?: string }): Promise<ReviewItem[]>`
  - `applyReview<T extends { n: number; score: number; title: string; hook: string; selected: boolean; review?: ClipReview }>(clips: T[], items: ReviewItem[], count: number): T[]`
  - `ClipState.review?: ClipReview` where `interface ClipReview { verdict: ReviewVerdict; problem?: string }` in `lib/types.ts`

- [ ] **Step 1: Add the types.** In `lib/types.ts`, add `export type ReviewVerdict = "pass" | "fix_hook" | "fail"; export interface ClipReview { verdict: ReviewVerdict; problem?: string }`, and to `ClipState` add `review?: ClipReview;` and `replayPeak?: number;` (doc: highest "Most replayed" value overlapping the clip, 0..1).

- [ ] **Step 2: Write the failing test** `test/review.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { applyReview } from "../src/review";

const clip = (n: number, score: number) => ({ n, score, title: `t${n}`, hook: `h${n}`, selected: true });

describe("applyReview", () => {
  it("unticks fails with the problem, rewrites fix_hook, ticks the best passing up to count", () => {
    const out = applyReview([clip(1, 9), clip(2, 8), clip(3, 7), clip(4, 6)], [
      { n: 1, verdict: "fail", problem: "ends before the payoff" },
      { n: 2, verdict: "fix_hook", title: "New title", hook: "New hook", problem: "quote hook" },
      { n: 3, verdict: "pass" },
    ], 2);
    expect(out[0]).toMatchObject({ selected: false, review: { verdict: "fail", problem: "ends before the payoff" } });
    expect(out[1]).toMatchObject({ selected: true, title: "New title", hook: "New hook", review: { verdict: "fix_hook" } });
    expect(out[2]).toMatchObject({ selected: true, review: { verdict: "pass" } });
    expect(out[3]).toMatchObject({ selected: false, review: { verdict: "pass" } }); // not mentioned = pass, but over count
  });
  it("ignores empty rewrite text, unknown n and duplicates", () => {
    const out = applyReview([clip(1, 5)], [
      { n: 1, verdict: "fix_hook", title: "", hook: "x" },
      { n: 1, verdict: "fail", problem: "dup" },
      { n: 99, verdict: "fail" },
    ], 3);
    expect(out[0]).toMatchObject({ title: "t1", hook: "h1", selected: true, review: { verdict: "fix_hook" } });
  });
});
```

- [ ] **Step 3: Run it.** `pnpm vitest run test/review.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement** `src/review.ts`

```ts
import { z } from "zod";
import type { Clip, Word } from "./types";
import { askAgent } from "./agents";
import type { AgentId, Audience, ClipReview, ReviewVerdict } from "../lib/types";

export interface ReviewItem {
  n: number;
  verdict: ReviewVerdict;
  problem?: string;
  title?: string;
  hook?: string;
}

const ReviewSchema = z.object({
  clips: z.array(
    z.object({
      n: z.number(),
      verdict: z.enum(["pass", "fix_hook", "fail"]),
      problem: z.string().optional().describe("One short sentence naming what is wrong (required for fix_hook and fail)"),
      title: z.string().optional().describe("fix_hook only: better title, under 60 chars"),
      hook: z.string().optional().describe("fix_hook only: better on-screen hook, under 40 chars, no emoji"),
    }),
  ),
});

/** A second, independent AI pass over the picks: it did not pick them, so it has nothing to defend. */
export async function reviewPicks(
  words: Word[],
  meta: { title: string; channel?: string },
  clips: (Clip & { n: number })[],
  o: { audience?: Audience; agent: AgentId; model?: string },
): Promise<ReviewItem[]> {
  const blocks = clips.map((c) => {
    const text = words.filter((w) => w.start >= c.start - 0.1 && w.start < c.end).map((w) => w.text).join(" ");
    return `#${c.n} (${Math.round(c.end - c.start)}s)\ntitle: ${c.title}\nhook: ${c.hook}\nwhy picked: ${c.reason}\ntranscript: ${text}`;
  });
  const prompt = `Source video: "${meta.title}"${meta.channel ? ` by ${meta.channel}` : ""}

Review these candidate vertical shorts. For each one check:
1. Does it hook in the first 2 seconds?
2. Does it make sense on its own to a viewer with zero context?
3. Does it end on a payoff or a complete thought?
4. Is the hook honest about what actually happens?
${o.audience === "en-us" ? "5. Will an American viewer get it (no unexplained local references)?\n" : ""}
verdict: "pass" if it's good; "fix_hook" if the moment is good but the title/hook is weak or misleading (then write better ones${o.audience === "en-us" ? " in US English" : " in the speakers' language"}); "fail" if the moment itself fails a check. Always give a short "problem" for fix_hook and fail. Be strict but fair: most picks should pass.

${blocks.join("\n\n")}`;
  const { $schema: _d, ...schema } = z.toJSONSchema(ReviewSchema, { target: "draft-7" }) as Record<string, unknown>;
  const res = await askAgent(o.agent, prompt, {
    model: o.model,
    maxTurns: 2,
    effort: "medium",
    system: "You are a strict short-form video editor reviewing someone else's picks. Answer only with the requested JSON.",
    schema,
  });
  const parsed = ReviewSchema.safeParse(res.data);
  if (!parsed.success) throw new Error(`Review output failed validation: ${parsed.error.message}`);
  return parsed.data.clips;
}

/** Apply verdicts: fix_hook rewrites title/hook, fail unticks; then tick the best passing clips up to `count`. */
export function applyReview<T extends { n: number; score: number; title: string; hook: string; selected: boolean; review?: ClipReview }>(clips: T[], items: ReviewItem[], count: number): T[] {
  const byN = new Map<number, ReviewItem>();
  for (const it of items) if (!byN.has(it.n)) byN.set(it.n, it);
  const out = clips.map((c) => {
    const it = byN.get(c.n);
    const verdict: ReviewVerdict = it?.verdict ?? "pass";
    const next = { ...c, review: { verdict, ...(it?.problem ? { problem: it.problem } : {}) } };
    if (verdict === "fix_hook" && it?.title?.trim() && it?.hook?.trim()) Object.assign(next, { title: it.title.trim(), hook: it.hook.trim() });
    return next;
  });
  const ok = out.filter((c) => c.review.verdict !== "fail").sort((a, b) => b.score - a.score).slice(0, count).map((c) => c.n);
  return out.map((c) => ({ ...c, selected: ok.includes(c.n) }));
}
```

- [ ] **Step 5: Run it.** `pnpm vitest run test/review.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add src/review.ts lib/types.ts test/review.test.ts && git commit -m "Picker: independent reviewer pass and verdict application"`

---

### Task 5: Audience setting (types, Settings, URL form, CLI)

**Files:**
- Modify: `lib/types.ts` (JobSettings.audience, AppSettings.audience, JobState.sourceLang/translated), `server/settings.ts` (effective, EffectiveSettings), `app/api/settings/route.ts` (Patch), `components/settings-form.tsx`, `components/url-form.tsx`, `server/jobs.ts:create`, `src/cli.ts`
- Test: `test/settings.test.ts` (extend)

**Interfaces:**
- Produces:
  - `JobSettings.audience?: Audience` (set at create from the app default when missing)
  - `AppSettings.audience?: Audience`
  - `EffectiveSettings.audience: Audience` (default `"en-us"`)
  - `JobState.sourceLang?: string`
  - `JobState.translated?: { start: number; end: number }[]`
  - `JobState.translateError?: string`

- [ ] **Step 1: Write the failing test.** Append to `test/settings.test.ts`, following the file's existing setup (temp `CAPY_DATA_DIR`, `resetSettingsCache`):

```ts
it("defaults audience to en-us and saves original", () => {
  expect(effective().audience).toBe("en-us");
  saveSettings({ audience: "original" });
  expect(effective().audience).toBe("original");
});
```

- [ ] **Step 2: Run it.** `pnpm vitest run test/settings.test.ts`. Expected: FAIL (`audience` undefined).
- [ ] **Step 3: Implement.**
  - **Types:** `lib/types.ts`: add `audience?: Audience` to `JobSettings` (doc: "who the clips are for: en-us writes text in US English and translates captions of non-English videos") and to `AppSettings`. Add `sourceLang?`, `translated?` and `translateError?` to `JobState`.
  - **Settings:** `server/settings.ts`: `EffectiveSettings` gains `audience: Audience`, and `effective()` returns `audience: s.audience ?? "en-us"`.
  - **Settings route:** `app/api/settings/route.ts` Patch: add `audience: z.enum(["original", "en-us"]).optional()`.
  - **Settings form:** `components/settings-form.tsx`: add `const [audience, setAudience] = useState<Audience>(initial.audience ?? "en-us")`, include `audience` in the saved patch, and add a `<Field label="Audience" hint="English (US) writes titles, hooks and descriptions for American viewers and translates captions when the video isn't in English.">` with a `<Select>` offering `en-us` "English (US)" and `original` "Same as the video".
  - **URL form:** `components/url-form.tsx`: in the settings panel next to Layout, add a `<Select>` labelled "Audience" with values `""` ("Default from Settings"), `en-us`, `original`, bound to `s.audience` (`""` → `undefined`).
  - **Job creation:** `server/jobs.ts` `create()`: after building `settings`, `settings.audience ??= effective().audience;` (import `effective` already exists).
  - **CLI:** `src/cli.ts`: add an `audience: { type: "string" }` option and a HELP line `  --audience en-us|original  Write text for US viewers and translate captions (default: Settings)`. Validate it, and resolve `const audience: Audience = (v.audience as Audience) ?? app.audience;`. Pass `audience` into `pickClips`. Before rendering, when `!isEnglish(meta.language ?? pickCaptionLang(meta, v.lang)?.lang)` and `audience === "en-us"`, build `enWords` by calling `translateRange(words, { start: c.start, end: c.end }, lang, { agent, model })` per clip inside the render pool, and pass `wordsInRange(enWords, …)` to `renderClip`.
- [ ] **Step 4: Run it.** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "Audience setting: en-us default in Settings, per-video override, CLI flag"`

---

### Task 6: Job manager wiring (peaks, review, translation, replace)

**Files:**
- Modify: `server/jobs.ts` (analyze, prepareSegments, refetchSegment, renderOne, generatePublish, suggestTitleHook; new `replaceClip`, `translateClip`, `getCaptionWords`, `sourceLang`)
- Modify: `src/pick.ts` (pickClips returns the full result for count 1 without throwing on empty)
- Create: `app/api/jobs/[id]/clips/[n]/replace/route.ts`, `app/api/jobs/[id]/clips/[n]/translate/route.ts`, `app/api/jobs/[id]/caption-words/route.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `jobs().replaceClip(id: string, n: number, reason?: string): Promise<ClipState>`
  - `jobs().translateClip(id: string, n: number): Promise<ClipState>`
  - `jobs().getCaptionWords(job: JobState): Promise<Word[]>` (`[]` when not translated)
  - `ClipState.captionsTranslated?: boolean | "error"`
  - `GET /api/jobs/[id]/caption-words` → `Word[]`
  - `POST …/clips/[n]/replace` with body `{ reason?: string }` → `ClipState`
  - `POST …/clips/[n]/translate` → `ClipState`

- [ ] **Step 1: Peaks and review in `analyze()`.** In the pick block:
  - Compute `const peaks = replayPeaks(meta.heatmap);`.
  - Call `stagePick` with `count: job.settings.count + 2`, `peaks`, and `audience: job.settings.audience`.
  - After mapping to `job.clips` (keep `selected: true`), set `c.replayPeak = peakFor(peaks, c.start, c.end)`.
  - Then:

```ts
        try {
          const items = await reviewPicks(words, { title: meta.title, channel: meta.channel }, job.clips, { audience: job.settings.audience, agent, model });
          job.clips = applyReview(job.clips, items, job.settings.count);
          const fails = job.clips.filter((c) => c.review?.verdict === "fail").length;
          const fixed = job.clips.filter((c) => c.review?.verdict === "fix_hook").length;
          this.log(job, "pick", `reviewer: ${job.clips.length - fails - fixed} passed, ${fixed} hooks rewritten, ${fails} flagged`);
        } catch (e) {
          // picking never fails because of the reviewer: keep the top `count` by score ticked
          const top = [...job.clips].sort((a, b) => b.score - a.score).slice(0, job.settings.count).map((c) => c.n);
          for (const c of job.clips) c.selected = top.includes(c.n);
          this.log(job, "pick", `review skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
```

  - Also set `job.sourceLang = meta.language ?? pickCaptionLang(meta, job.settings.lang)?.lang;` right after the words stage (import `pickCaptionLang` from `../src/youtube`).
  - For the replace step, store `meta` for later use: `this.metas.set(job.id, meta)`, with a new `metas = new Map<string, VideoMeta>()` field (lazily created like `analyzing`). Add `private async getMeta(job)`, which falls back to reading `<jobDir>/meta.json`.

- [ ] **Step 2: Translation after segments.** Add:

```ts
  private needsTranslation(job: JobState) {
    return job.settings.audience === "en-us" && !isEnglish(job.sourceLang);
  }

  /** Translate the clip's padded segment range into <jobDir>/words.en.json (only the parts not translated yet). */
  private async translateFor(job: JobState, c: ClipState) {
    if (!this.needsTranslation(job) || !c.segment) return;
    const range = { start: c.segment.start, end: c.segment.end };
    const covered = (job.translated ?? []).some((r) => r.start <= range.start + 0.01 && r.end >= range.end - 0.01);
    if (covered) { c.captionsTranslated = true; return; }
    const jobDir = path.join(OUTPUT_ROOT, job.dir);
    const { agent, model } = await this.ai(job);
    try {
      const add = await translateRange(await this.getWords(job), range, job.sourceLang, { agent, model });
      const file = path.join(jobDir, "words.en.json");
      const existing: Word[] = JSON.parse(await readFile(file, "utf8").catch(() => "[]"));
      await writeFile(file, JSON.stringify(mergeWords(existing, add, range)));
      this.captionWords.delete(job.id);
      job.translated = [...(job.translated ?? []), range];
      c.captionsTranslated = true;
    } catch (e) {
      c.captionsTranslated = "error";
      this.log(job, "segments", `clip ${c.n} captions not translated: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
```

  - Call `await this.translateFor(job, c)` at the end of each pool item in `prepareSegments` (after a successful download) and at the end of `refetchSegment` (on success).
  - Add `captionWords = new Map<string, Word[]>()` (lazy getter like `analyzing`) and `async getCaptionWords(job)`, which reads `words.en.json`, caches it, and returns `[]` when the file is missing.
  - Add `captionsTranslated?: boolean | "error"` to `ClipState` in `lib/types.ts`.

- [ ] **Step 3: Render with English words.** In `renderOne`, replace `const words = await this.getWords(job);` with:

```ts
    const words = c.captionsTranslated === true ? await this.getCaptionWords(job) : await this.getWords(job);
```

- [ ] **Step 4: Pass the audience to text helpers.** `generatePublish(..., model, agent, job.settings.audience)` and `rewriteTitleHook(..., model, agent, job.settings.audience)`.

- [ ] **Step 5: `replaceClip` and `translateClip`**

```ts
  /** Swap one pick for a new moment, steering the picker away from `reason`. */
  async replaceClip(id: string, n: number, reason?: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    if (c.render.status === "rendering" || c.render.status === "done") throw Object.assign(new Error("This clip is rendered. Remove it instead."), { status: 409 });
    const words = await this.getWords(job);
    const meta = await this.getMeta(job);
    const { agent, model } = await this.ai(job);
    const why = reason?.trim() || c.review?.problem || "the editor wants a different moment";
    this.log(job, "pick", `replacing clip ${n}: ${why}`);
    const res = await pickClips(words, meta, {
      count: 1, minSec: job.settings.minSec, maxSec: job.settings.maxSec, agent, model, focus: job.settings.focus,
      audience: job.settings.audience, peaks: replayPeaks(meta.heatmap),
      replace: { start: c.start, end: c.end, reason: why, avoid: job.clips.filter((x) => x.n !== n).map((x) => ({ start: x.start, end: x.end })) },
    });
    const taken = [c, ...job.clips.filter((x) => x.n !== n)];
    const fresh = res.clips.find((x) => !taken.some((t) => x.start < t.end - 1 && x.end > t.start + 1));
    if (!fresh) throw new Error("No other good moment found. Try a different reason or a longer max length.");
    let next: ClipState = {
      ...fresh, n, selected: true, render: { status: "none" },
      publish: fresh.ytTitle ? { ytTitle: fresh.ytTitle, description: fresh.description ?? "", hashtags: fresh.hashtags ?? [] } : undefined,
      replayPeak: peakFor(replayPeaks(meta.heatmap), fresh.start, fresh.end),
    };
    try {
      const items = await reviewPicks(words, { title: meta.title, channel: meta.channel }, [next], { audience: job.settings.audience, agent, model });
      next = applyReview([next], items, 1)[0]!;
    } catch (e) {
      this.log(job, "pick", `review skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    job.clips = job.clips.map((x) => (x.n === n ? next : x));
    await this.update(job);
    void this.refetchSegment(job, next);
    return next;
  }

  /** Retry the caption translation for one clip. */
  async translateClip(id: string, n: number) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    await this.translateFor(job, c);
    await this.update(job);
    return c;
  }
```

  `pickClips` already returns `{ clips: [] }` when everything is filtered out, so nothing changes there. Make sure `replace` is threaded from `PickOpts` into `buildPrompt` (it is, through `o`).

- [ ] **Step 6: Routes.**
  - `app/api/jobs/[id]/clips/[n]/replace/route.ts`:

```ts
import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** POST { reason? } = swap this pick for a new moment that avoids the reason. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await jobs().replaceClip(id, Number(n), typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
```

  - `…/translate/route.ts` follows the same shape and calls `jobs().translateClip(id, Number(n))`.
  - `app/api/jobs/[id]/caption-words/route.ts` is a copy of the words route, but returns `await m.getCaptionWords(job)`.

- [ ] **Step 7: Run it.** `pnpm vitest run && pnpm typecheck && pnpm build`. Expected: all pass, and the build compiles the new routes.
- [ ] **Step 8: Commit.** `git add -A server src app lib && git commit -m "Jobs: replay peaks, reviewer, English caption translation, per-clip replace"`

---

### Task 7: UI (badges, reviewer notes, Replace, English preview)

**Files:**
- Modify: `components/pick-card.tsx`, `hooks/use-job.ts` (useCaptionWords), `components/clip-editor.tsx`
- Create: `components/replace-popover.tsx`

**Interfaces:**
- Consumes: `ClipState.review`, `replayPeak`, `captionsTranslated`; the routes from Task 6.
- Produces: `useCaptionWords(id: string | null, version: string): Word[] | null`; `<ReplacePopover jobId clip />`.

- [ ] **Step 1: `useCaptionWords`** in `hooks/use-job.ts`. It refetches `/api/jobs/${id}/caption-words` whenever `version` changes (pass `JSON.stringify(job.translated ?? [])`). It returns `null` until loaded.

- [ ] **Step 2: Pick card.**
  - In the top row, after the time chip, when `clip.replayPeak !== undefined && clip.replayPeak >= 0.7`, show `<span className="rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-orange-300 backdrop-blur"><Flame className="mr-0.5 inline size-3" />Most replayed</span>` (the `Flame` icon is from lucide-react).
  - In the bottom text, above the title, add:
    - `review.verdict === "fail"`: `<p className="mb-1 line-clamp-2 text-[11px] text-red-400">Reviewer: {clip.review.problem}</p>`
    - `fix_hook`: `<p className="mb-1 text-[11px] text-white/60">Hook rewritten</p>`
    - `captionsTranslated === "error"`: `<p className="mb-1 text-[11px] text-amber-400">Captions not translated</p>`
  - Below the card, when `clip.render.status` is not `done` or `rendering`, render `<ReplacePopover jobId={jobId} clip={clip} />`, positioned top-right on hover (`absolute right-2 top-9 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100`).

- [ ] **Step 3: `components/replace-popover.tsx`**
  - Built with Radix Dialog (already a dependency) as a small dialog.
  - Trigger: a `Button size="sm" variant="secondary"` with `<RefreshCw />` and "Replace".
  - Body: a `<Textarea>` prefilled with `clip.review?.problem ?? ""` and the placeholder "What's wrong with this pick? e.g. ends before the punchline". Buttons: Cancel, and Replace (spinner while busy).
  - Submit sends `api(\`/api/jobs/${jobId}/clips/${clip.n}/replace\`, { method: "POST", body: JSON.stringify({ reason }) })`. Errors show as red text in the dialog, and success closes it. The job SSE refreshes the card.
  - When `clip.captionsTranslated === "error"`, also show a "Retry translation" button that POSTs to `/translate`.

- [ ] **Step 4: Editor.** In `components/clip-editor.tsx`, call `const capWords = useCaptionWords(id, JSON.stringify(job?.translated ?? []));` and build `clipCaptionWords` the same way as `clipWords`, but from `capWords` when `clip?.captionsTranslated === true && capWords?.length`. Pass `clipCaptionWords` to `<CaptionOverlay words=…>`. The `Transcript` props stay unchanged (original words).

- [ ] **Step 5: Run it.** `pnpm typecheck && pnpm build`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add -A components hooks && git commit -m "UI: Most-replayed badge, reviewer notes, Replace dialog, English caption preview"`

---

### Task 8: End-to-end verification in the app

- [ ] **Step 1:** Start the dev server with `preview_start` (`.claude/launch.json`), and paste an English video that has a heatmap (any popular podcast episode).
- [ ] **Step 2:** Check that the log shows `reviewer: … passed …`, that 8 picks exist with 6 ticked, that at least one "Most replayed" badge appears when the clip overlaps a peak, and that Replace on a card returns a different range.
- [ ] **Step 3:** Paste a non-English (for example Portuguese) video with audience English (US). Check that the titles and hooks are English, that `words.en.json` exists in the job folder, that the editor preview shows English captions, and that one rendered clip has English burned-in captions. Grab a frame and look at it.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck`. Then commit any fixes.
