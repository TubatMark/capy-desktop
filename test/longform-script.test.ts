import { expect, it, vi } from "vitest";
const agents = vi.hoisted(() => ({ askAgent: vi.fn() }));
vi.mock("../src/agents", () => agents);
import { reviseScript, writeScript } from "../src/longform/script";
import type { LongClip } from "../lib/longform";

const clip = { title: "t", excerpt: "e", sourceTitle: "s" } as LongClip & { excerpt: string };
const script = (ranks: number[]) => ({ title: "T", thumbnailText: "x", intro: "i", outro: "o", description: "d", tags: [], otherTitles: ["a", "b"], lines: ranks.map((rank) => ({ rank, line: "l", label: "Best Moment" })) });
const o = { agent: "claude" as const };

it("acts on the review's notes, keeping the same ranks", async () => {
  agents.askAgent.mockResolvedValue({ data: script([1, 2]) });
  await reviseScript("Ray", [clip, clip], script([1, 2]), ["Soften the claim about the car"], o);
  const prompt = agents.askAgent.mock.calls.at(-1)![1] as string;
  expect(prompt).toContain("Soften the claim about the car");
  expect(prompt).toContain("current script");
});

it("refuses a script that skips a rank", async () => {
  agents.askAgent.mockResolvedValue({ data: script([1]) });
  await expect(writeScript("Ray", [clip, clip], o)).rejects.toThrow(/no line for rank 2/);
  await expect(reviseScript("Ray", [clip, clip], script([1, 2]), ["n"], o)).rejects.toThrow(/no line for rank 2/);
});
