import { beforeEach, describe, expect, it, vi } from "vitest";
const agents = vi.hoisted(() => ({ askAgent: vi.fn() }));
vi.mock("../src/agents", () => agents);
import { writeCheckedCommentary } from "../src/shorts-commentary";

const o = { creator: "DDG", title: "t", excerpt: "e" };
const ai = { agent: "claude" as const };
const lines = (opening: string) => ({ opening, middle: "A short middle line", verdict: "A short verdict line. Your take?" });
const pass = { adds: true, consistent: true, why: "" };
const contradicts = { adds: true, consistent: false, why: "smart, then dumb" };
const describes = { adds: false, consistent: true, why: "only describes" };

/** Answers in order, telling writes (which carry the role prompt) from checks. */
function script(writes: object[], checks: (object | Error)[]) {
  agents.askAgent.mockImplementation(async (_a: string, prompt: string) => {
    if (prompt.startsWith("A clips channel's host says")) {
      const next = checks.shift()!;
      if (next instanceof Error) throw next;
      return { data: next };
    }
    return { data: writes.shift()! };
  });
}

describe("checking the host's lines", () => {
  beforeEach(() => {
    agents.askAgent.mockReset();
  });

  it("keeps good lines without rewriting", async () => {
    script([lines("first")], [pass]);
    expect((await writeCheckedCommentary(o, ai)).opening).toBe("first");
  });
  it("rewrites contradictions with the editor's note", async () => {
    script([lines("first"), lines("second")], [contradicts, pass]);
    expect((await writeCheckedCommentary(o, ai)).opening).toBe("second");
    expect(agents.askAgent.mock.calls.some((c) => String(c[1]).includes("smart, then dumb"))).toBe(true);
  });
  it("leaves the clip plain if the host still contradicts themself", async () => {
    script([lines("a"), lines("b"), lines("c")], [contradicts, contradicts, contradicts]);
    await expect(writeCheckedCommentary(o, ai)).rejects.toThrow(/contradict/);
  });
  it("uses lines that only describe once rewrites run out", async () => {
    script([lines("a"), lines("b"), lines("c")], [describes, describes, describes]);
    expect((await writeCheckedCommentary(o, ai)).opening).toBe("c");
  });
  it("asks the second AI too, and rewrites when only it objects", async () => {
    const second = { agent: "codex" as const };
    script([lines("first"), lines("second")], [pass, contradicts, pass, pass]);
    expect((await writeCheckedCommentary(o, ai, second)).opening).toBe("second");
    const checkers = agents.askAgent.mock.calls.filter((c) => String(c[1]).startsWith("A clips channel's host says")).map((c) => c[0]);
    expect(checkers).toEqual(["claude", "codex", "claude", "codex"]);
  });
  it("leaves the clip plain if the second AI never accepts the lines", async () => {
    script([lines("a"), lines("b"), lines("c")], [pass, contradicts, pass, contradicts, pass, contradicts]);
    await expect(writeCheckedCommentary(o, ai, { agent: "codex" })).rejects.toThrow(/contradict/);
  });
  it("keeps the first AI's read when the second is unavailable", async () => {
    script([lines("first")], [pass, new Error("not logged in")]);
    expect((await writeCheckedCommentary(o, ai, { agent: "codex" })).opening).toBe("first");
  });
  it("doesn't lose a clip because the check itself failed", async () => {
    script([lines("first")], [new Error("down")]);
    expect((await writeCheckedCommentary(o, ai)).opening).toBe("first");
  });
});
