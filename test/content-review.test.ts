import { describe, expect, it } from "vitest";
import { buildContentPrompt, normalizeContentReview, reviewUnavailable } from "../src/content-review";

describe("normalizeContentReview", () => {
  it("keeps a valid review and stamps the time", () => {
    const r = normalizeContentReview({ verdict: "caution", summary: "Fine, but the title oversells it.", issues: [{ kind: "misleading", note: "Nobody gets hurt" }], title: "Better title" }, 5);
    expect(r).toEqual({ verdict: "caution", summary: "Fine, but the title oversells it.", issues: [{ kind: "misleading", note: "Nobody gets hurt" }], title: "Better title", at: 5 });
  });
  it("treats an unknown verdict as caution and trims long text", () => {
    const r = normalizeContentReview({ verdict: "maybe", summary: "x".repeat(900), issues: Array.from({ length: 20 }, () => ({ kind: "k", note: "n" })) }, 1);
    expect(r.verdict).toBe("caution");
    expect(r.summary.length).toBeLessThanOrEqual(400);
    expect(r.issues.length).toBeLessThanOrEqual(8);
  });
  it("drops a blank or over-long suggested title", () => {
    expect(normalizeContentReview({ verdict: "ok", summary: "ok", issues: [], title: "  " }, 1).title).toBeUndefined();
    expect(normalizeContentReview({ verdict: "ok", summary: "ok", issues: [], title: "y".repeat(140) }, 1).title).toBeUndefined();
  });
});

describe("reviewUnavailable", () => {
  it("is a caution that says why, never a block", () => {
    expect(reviewUnavailable("timeout", 3)).toEqual({ verdict: "caution", summary: "AI review unavailable: timeout. Check this clip yourself.", issues: [], at: 3 });
  });
});

describe("buildContentPrompt", () => {
  const base = { videoTitle: "Ep", channel: "GNT", clipTitle: "A trip", hook: "She hitchhiked", transcript: "she hitchhiked to bahia", ytTitle: "T #shorts", caption: "C", hashtags: ["shorts"] };
  it("includes the post text and the transcript", () => {
    const p = buildContentPrompt(base);
    expect(p).toContain("She hitchhiked");
    expect(p).toContain("T #shorts");
    expect(p).toContain("she hitchhiked to bahia");
    expect(p).not.toContain("Original-language transcript");
  });
  it("asks to check the translation when there is an original transcript", () => {
    const p = buildContentPrompt({ ...base, original: "ela pegou carona até a bahia", sourceLang: "pt-BR" });
    expect(p).toContain("Original-language transcript (pt-BR)");
    expect(p).toContain("ela pegou carona");
  });
});
