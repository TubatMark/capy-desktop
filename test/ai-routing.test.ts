import { describe, expect, it } from "vitest";
import { resolveAiTask, DEFAULT_AI_ROUTING } from "../lib/ai-policy";
import { applyReview } from "../src/review";

describe("AI routing", () => {
  it("simple tasks do not use premium models or call AI for technical edits", () => {
    expect(
      resolveAiTask("metadata", { agent: "claude", model: "claude-opus-5-5" })
        .model,
    ).toBe("claude-haiku-5-5");
    expect(resolveAiTask("selection", { agent: "claude" }).model).toBe(
      "claude-sonnet-5-5",
    );
    expect(resolveAiTask("resize", {}).provider).toBe("local");
    expect(resolveAiTask("thumbnail-text", {}).provider).toBe("local");
    expect(() =>
      resolveAiTask("vision", { agent: "codex", requiredModality: "image" }),
    ).toThrow(/capability/i);
    expect(() => resolveAiTask("metadata", { allowCloud: false })).toThrow(
      /cloud/i,
    );
  });
  it("creator overrides cannot increase limits or enable premium implicitly", () => {
    const p = resolveAiTask("metadata", {
      creatorOverride: { maxJobUsd: 100, maxDayUsd: 100 },
    });
    expect(p.maxJobUsd).toBe(DEFAULT_AI_ROUTING.maxJobUsd);
    expect(p.maxDayUsd).toBe(DEFAULT_AI_ROUTING.maxDayUsd);
  });
  it("review failure never auto approves missing duplicate or incomplete output", () => {
    const clips = [
      { n: 1, score: 9, title: "title", hook: "hook", selected: true },
    ];
    expect(applyReview(clips, [], 1)[0]).toMatchObject({
      selected: false,
      review: { verdict: "needs_review" },
    });
    expect(
      applyReview(
        clips,
        [
          { n: 1, verdict: "pass" },
          { n: 1, verdict: "pass" },
        ],
        1,
      )[0]?.selected,
    ).toBe(false);
    expect(
      applyReview(
        clips,
        [{ n: 1, verdict: "fix_hook", title: "", hook: "x" }],
        1,
      )[0]?.selected,
    ).toBe(false);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db";
import {
  routeAiTask,
  withAiContext,
  type AiAdapter,
  type RoutedAiRequest,
} from "../server/ai-router";
import { getAiUsage } from "../server/ai-usage";
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "capy-route-"));
  const store = new Store(path.join(dir, "db.sqlite"));
  const request: RoutedAiRequest = {
    task: "metadata",
    agent: "claude",
    prompt: "Selected clip: an honest payoff",
    system: "Write a title",
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    context: {
      settings: { ...DEFAULT_AI_ROUTING, tasks: {} },
      inputVersion: "v1",
    },
  };
  return {
    store,
    request,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
describe("routed execution", () => {
  it("cache and context are task scoped and invalidate on input model schema or parameters", async () => {
    const f = fixture();
    let calls = 0;
    const adapter: AiAdapter = async () => {
      calls++;
      return {
        data: { title: "Honest title" },
        cost: { basis: "estimated", value: 0.01 },
      };
    };
    try {
      await routeAiTask(f.request, adapter, f.store);
      expect((await routeAiTask(f.request, adapter, f.store)).cached).toBe(
        true,
      );
      expect(calls).toBe(1);
      await routeAiTask(
        { ...f.request, context: { ...f.request.context, inputVersion: "v2" } },
        adapter,
        f.store,
      );
      await routeAiTask(
        { ...f.request, prompt: "Changed selected clip transcript" },
        adapter,
        f.store,
      );
      await routeAiTask(
        { ...f.request, parameters: { temperature: 0.2 } },
        adapter,
        f.store,
      );
      await routeAiTask(
        {
          ...f.request,
          schema: { ...f.request.schema, additionalProperties: false },
        },
        adapter,
        f.store,
      );
      await routeAiTask(
        {
          ...f.request,
          context: {
            ...f.request.context,
            settings: {
              ...DEFAULT_AI_ROUTING,
              tasks: {
                metadata: {
                  agent: "claude",
                  model: "claude-haiku-4-5-20251001",
                  premium: false,
                },
              },
            },
          },
        },
        adapter,
        f.store,
      );
      expect(calls).toBe(6);
      await expect(
        routeAiTask(
          { ...f.request, prompt: "x".repeat(17000) },
          adapter,
          f.store,
        ),
      ).rejects.toThrow(/context/i);
      expect(calls).toBe(6);
      expect(
        getAiUsage(f.store).tasks.find((t) => t.task === "metadata")?.cached,
      ).toBe(1);
    } finally {
      f.close();
    }
  });
  it("retry and escalation share budget and stop after one of each", async () => {
    const f = fixture();
    const models: string[] = [];
    const adapter: AiAdapter = async (_agent, _prompt, options) => {
      models.push(options.model);
      expect(options.maxBudgetUsd).toBe(0.1);
      return { data: { wrong: true }, cost: { basis: "unknown" } };
    };
    f.request.context!.settings = {
      ...DEFAULT_AI_ROUTING,
      tasks: {
        metadata: {
          agent: "claude",
          model: "claude-haiku-5-5",
          premium: false,
          escalation: { agent: "claude", model: "claude-sonnet-5-5" },
        },
      },
    };
    try {
      await expect(routeAiTask(f.request, adapter, f.store)).rejects.toThrow(
        /validation/i,
      );
      expect(models).toEqual([
        "claude-haiku-5-5",
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
      ]);
      const reservations = f.store.list<any>("ai-reservation");
      expect(reservations).toHaveLength(1);
      expect(reservations[0]?.value.ceilingUsd).toBeCloseTo(0.3);
      expect(getAiUsage(f.store)).toMatchObject({
        requests: 3,
        usd: 0.30000000000000004,
      });
    } finally {
      f.close();
    }
  });
  it("budget refusal and local-only capability failure never invoke adapters", async () => {
    const f = fixture();
    let calls = 0;
    const adapter: AiAdapter = async () => {
      calls++;
      throw Error("must not run");
    };
    try {
      f.request.context!.settings = {
        ...DEFAULT_AI_ROUTING,
        maxDayRequests: 0,
        tasks: {},
      };
      await expect(routeAiTask(f.request, adapter, f.store)).rejects.toThrow(
        /budget/i,
      );
      f.request.context!.allowCloud = false;
      await expect(routeAiTask(f.request, adapter, f.store)).rejects.toThrow(
        /cloud/i,
      );
      expect(calls).toBe(0);
    } finally {
      f.close();
    }
  });
  it("ambient worker context shares a job cap across different tasks", async () => {
    const f = fixture();
    const adapter: AiAdapter = async () => ({
      data: { title: "Title" },
      cost: { basis: "unknown" },
    });
    f.request.context!.settings = {
      ...DEFAULT_AI_ROUTING,
      maxJobUsd: 0.2,
      tasks: {},
    };
    try {
      await withAiContext({ jobId: "stable-job" }, () =>
        routeAiTask(f.request, adapter, f.store),
      );
      await expect(
        withAiContext({ jobId: "stable-job" }, () =>
          routeAiTask(
            { ...f.request, task: "edit-assistance", prompt: "changed" },
            adapter,
            f.store,
          ),
        ),
      ).rejects.toThrow(/budget/i);
      expect(f.store.get<any>("ai-budget-job", "stable-job")?.value.usd).toBe(
        0.2,
      );
    } finally {
      f.close();
    }
  });
});

it("strict provider quota mode rejects all unverified adapters before reservation or provider work", async () => {
  const f = fixture();
  let calls = 0;
  const adapter: AiAdapter = async () => {
    calls++;
    throw Error("must not run");
  };
  try {
    for (const agent of ["claude", "codex", "gemini"] as const) {
      const settings = {
        ...DEFAULT_AI_ROUTING,
        usageLimitMode: "provider" as const,
        tasks: {},
      };
      await expect(
        routeAiTask(
          {
            ...f.request,
            agent,
            context: {
              settings,
              creatorOverride: { usageLimitMode: "application" } as any,
            },
          },
          adapter,
          f.store,
        ),
      ).rejects.toThrow(/strict provider/);
    }
    expect(calls).toBe(0);
    expect(f.store.list("ai-reservation")).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("application mode separates unknown provider usage from finite admission allowance", async () => {
  const f = fixture();
  try {
    await routeAiTask(
      { ...f.request, agent: "codex" },
      async () => ({ data: { title: "Title" }, cost: { basis: "unknown" } }),
      f.store,
    );
    const usage = getAiUsage(f.store);
    expect(usage.accounting).toBe("application-admission");
    expect(usage.providerRequests).toBeNull();
    expect(usage.reportedTokens).toBe(0);
    expect(usage.unknownUsageRuns).toBe(1);
    expect(usage.tokens).toBeGreaterThan(0);
    expect(usage.requests).toBe(1);
  } finally {
    f.close();
  }
});
