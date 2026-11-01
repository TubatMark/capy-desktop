import { expect, it, vi } from "vitest";
const agents = vi.hoisted(() => ({ askAgent: vi.fn() }));
vi.mock("../src/agents", () => agents);
import { reviewScriptTwice, reviseScript, writeScript } from "../src/longform/script";
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

const answers = (claude: object | Error, codex: object | Error) =>
  agents.askAgent.mockImplementation(async (agent: string) => {
    const next = agent === "codex" ? codex : claude;
    if (next instanceof Error) throw next;
    return { data: next };
  });
const reviewed = () => reviewScriptTwice(script([1]) as never, { agent: "claude" }, { agent: "codex" });
const ok = { verdict: "ok", serious: false, notes: [] };
const minor = { verdict: "caution", serious: false, notes: ["minor"] };
const serious = (note: string) => ({ verdict: "caution", serious: true, notes: [note] });

it("rewrites on either AI's notes, but only holds when both call it serious", async () => {
  answers(ok, serious("codex note"));
  expect(await reviewed()).toEqual({ verdict: "caution", serious: false, notes: ["codex note"] });
  answers(minor, serious("codex note"));
  expect((await reviewed()).serious).toBe(false);
  answers(serious("claude note"), serious("codex note"));
  expect(await reviewed()).toEqual({ verdict: "caution", serious: true, notes: ["claude note", "codex note"] });
  answers(ok, ok);
  expect(await reviewed()).toEqual({ verdict: "ok", serious: false, notes: [] });
});

it("one AI being down leaves the other's review standing and never holds the video", async () => {
  answers(serious("claude note"), new Error("not logged in"));
  expect(await reviewed()).toEqual({ verdict: "caution", serious: false, notes: ["claude note"] });
  answers(new Error("down"), new Error("down"));
  await expect(reviewed()).rejects.toThrow(/Neither AI/);
});
