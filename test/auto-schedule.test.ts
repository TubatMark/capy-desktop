import { expect, it } from "vitest";
import { combineReviews, reviewUnavailable } from "../src/content-review";
import { autoScheduleBlockers, similarClear } from "../server/auto-schedule";
import type { ClipSimilarity } from "../lib/similarity";
import type { ContentReview, QueueEntry } from "../lib/types";

const r = (verdict: ContentReview["verdict"], note?: string): ContentReview => ({
  verdict,
  summary: `${verdict} summary`,
  issues: note ? [{ kind: "other", note }] : [],
  at: 1,
});

it("two AI reviews: OK when one says OK and none blocks; any block blocks; a reviewer that couldn't run doesn't count", () => {
  expect(combineReviews([{ by: "claude", review: r("ok") }, { by: "codex", review: r("caution", "check the claim") }])).toMatchObject({
    verdict: "ok",
    issues: [{ note: "check the claim" }],
  });
  expect(combineReviews([{ by: "claude", review: r("ok") }, { by: "codex", review: r("block", "policy") }]).verdict).toBe("block");
  expect(combineReviews([{ by: "claude", review: r("caution") }, { by: "codex", review: r("caution") }]).verdict).toBe("caution");
  const one = combineReviews([{ by: "claude", review: r("ok") }, { by: "codex", review: reviewUnavailable("not installed", 2) }]);
  expect(one.verdict).toBe("ok");
  expect(one.opinions?.map((o) => [o.by, !!o.unavailable])).toEqual([["claude", false], ["codex", true]]);
  const none = combineReviews([
    { by: "claude", review: reviewUnavailable("down", 2) },
    { by: "codex", review: reviewUnavailable("down", 2) },
  ]);
  expect(none).toMatchObject({ verdict: "caution", unavailable: true });
});

const sim = (over: Partial<ClipSimilarity>): ClipSimilarity => ({
  checkedAt: 1,
  setHash: "h",
  candidates: [],
  opinions: [],
  unavailable: [],
  verdict: { level: "distinct", agreement: "none", similarTo: [] },
  ...over,
});
const op = (by: "claude" | "codex", level: "distinct" | "similar" | "near-duplicate") => ({
  by,
  level,
  similarTo: [],
  why: "w",
  recommendation: "r",
});

it("similar clips: clear when nothing is close or one AI says distinct and none says near-copy", () => {
  expect(similarClear(sim({}))).toBe(true);
  expect(similarClear(sim({ verdict: { level: "similar", agreement: "differ", similarTo: [] }, opinions: [op("claude", "distinct"), op("codex", "similar")] }))).toBe(true);
  expect(similarClear(sim({ verdict: { level: "near-duplicate", agreement: "differ", similarTo: [] }, opinions: [op("claude", "distinct"), op("codex", "near-duplicate")] }))).toBe(false);
  expect(similarClear(sim({ verdict: { level: "unchecked", agreement: "none", similarTo: [] } }))).toBe(false);
});

it("auto-schedule waits for an OK review, a finished similar-clips check and a designed thumbnail", () => {
  const yt = {
    key: "j:1:youtube",
    platform: "youtube",
    aiReview: r("ok"),
    publishPackage: { thumbnail: { designId: "d" } },
  } as unknown as QueueEntry;
  expect(autoScheduleBlockers([yt], sim({}))).toEqual([]);
  // "check this" is accepted by default (owner's choice); "don't post" never is
  expect(autoScheduleBlockers([{ ...yt, aiReview: r("caution") }], sim({}))).toEqual([]);
  expect(autoScheduleBlockers([{ ...yt, aiReview: r("block") }], sim({}))).toEqual(["An AI reviewer said don't post it"]);
  expect(autoScheduleBlockers([yt], undefined)).toEqual(["The similar-clips check hasn't finished"]);
  expect(autoScheduleBlockers([yt], sim({ checking: 5 }))).toEqual(["The similar-clips check hasn't finished"]);
  expect(autoScheduleBlockers([{ ...yt, publishPackage: undefined }], sim({}))).toEqual(["No designed thumbnail is attached yet"]);
});
