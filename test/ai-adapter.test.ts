import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { resetSettingsCache } from "../server/settings";
import { DEFAULT_AI_ROUTING } from "../lib/ai-policy";
const fake = vi.hoisted(() => ({
  calls: 0,
  costBasis: "list",
  env: {} as Record<string, string | undefined>,
  model: "",
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: any }) =>
    (async function* () {
      fake.calls++;
      fake.env = options.env;
      fake.model = options.model;
      yield {
        type: "result",
        structured_output: { ok: true },
        total_cost_usd: 0.01,
        num_turns: 1,
        modelUsage: {
          test: { costBasis: fake.costBasis, canonicalModel: options.model },
        },
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    })(),
}));
import { askAgent, askClaude } from "../src/agents";
let dir: string;
let original: NodeJS.ProcessEnv;
beforeEach(() => {
  original = { ...process.env };
  dir = mkdtempSync(path.join(tmpdir(), "capy-adapter-"));
  process.env.CAPY_DATA_DIR = dir;
  delete process.env.CAPY_USE_API_KEY;
  delete process.env.CLIPRUN_USE_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-paid";
  resetSettingsCache();
  fake.calls = 0;
  fake.costBasis = "list";
});
afterEach(() => {
  process.env = original;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});
const options = {
  task: "metadata" as const,
  system: "Diagnostic fixture",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
  context: { settings: { ...DEFAULT_AI_ROUTING, tasks: {} } },
};
it("actual shared adapter routes simple tasks compact, accounts estimates and preserves subscription auth", async () => {
  const result = await askAgent("claude", "fixture-only", {
    ...options,
    model: "claude-opus-5-5",
  });
  expect(fake.calls).toBe(1);
  expect(fake.model).toBe("claude-haiku-5-5");
  expect(fake.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(result.cost).toEqual({ basis: "estimated", value: 0.01 });
  expect(result.actualModel).toBe("claude-haiku-5-5");
  expect((await askAgent("claude", "fixture-only", options)).cached).toBe(true);
  expect(fake.calls).toBe(1);
});
it("unknown SDK price basis stays unknown rather than using its guessed estimate", async () => {
  fake.costBasis = "unknown";
  const result = await askAgent("claude", "unknown-price", options);
  expect(result.cost).toEqual({ basis: "unknown" });
  expect(result.costUsd).toBeUndefined();
});
it("legacy public Claude diagnostics cannot bypass budgets", async () => {
  const { saveSettings } = await import("../server/settings");
  saveSettings({
    aiRouting: { ...DEFAULT_AI_ROUTING, maxDayRequests: 0, tasks: {} },
  });
  await expect(askClaude("Reply ready", {})).rejects.toThrow(/budget/i);
  expect(fake.calls).toBe(0);
});
it("explicit API auth remains explicit", async () => {
  process.env.CAPY_USE_API_KEY = "1";
  await askAgent("claude", "api-auth-fixture", options);
  expect(fake.env.ANTHROPIC_API_KEY).toBe("test-key-not-paid");
});

it("explicit diagnostics always make a fresh admitted call", async () => {
  await askAgent("claude", "diagnostic", { ...options, task: "diagnostic" });
  await askAgent("claude", "diagnostic", { ...options, task: "diagnostic" });
  expect(fake.calls).toBe(2);
});
