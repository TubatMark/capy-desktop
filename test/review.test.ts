import { describe, expect, it } from "vitest";
import { applyReview } from "../src/review";

const clip = (n: number, score: number) => ({ n, score, title: `t${n}`, hook: `h${n}`, selected: true });

describe("applyReview", () => {
  it("unticks fails with the problem, rewrites fix_hook, ticks the best passing up to count", () => {
    const out = applyReview(
      [clip(1, 9), clip(2, 8), clip(3, 7), clip(4, 6)],
      [
        { n: 1, verdict: "fail", problem: "ends before the payoff" },
        { n: 2, verdict: "fix_hook", title: "New title", hook: "New hook", problem: "quote hook" },
        { n: 3, verdict: "pass" },
      ],
      2,
    );
    expect(out[0]).toMatchObject({ selected: false, review: { verdict: "fail", problem: "ends before the payoff" } });
    expect(out[1]).toMatchObject({ selected: true, title: "New title", hook: "New hook", review: { verdict: "fix_hook" } });
    expect(out[2]).toMatchObject({ selected: true, review: { verdict: "pass" } });
    expect(out[3]).toMatchObject({ selected: false, review: { verdict: "pass" } }); // not mentioned = pass, but over count
  });
  it("ignores empty rewrite text, unknown n and duplicates", () => {
    const out = applyReview(
      [clip(1, 5)],
      [
        { n: 1, verdict: "fix_hook", title: "", hook: "x" },
        { n: 1, verdict: "fail", problem: "dup" },
        { n: 99, verdict: "fail" },
      ],
      3,
    );
    expect(out[0]).toMatchObject({ title: "t1", hook: "h1", selected: true, review: { verdict: "fix_hook" } });
  });
});
