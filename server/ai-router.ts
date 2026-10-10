import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  resolveAiTask,
  type AiTaskContext,
  type AiTaskId,
  type AiTaskPolicy,
} from "../lib/ai-policy";
import type { AgentId } from "../lib/types";
import type { Store } from "./db";
import { runtimeStore } from "./db/runtime";
import { loadSettings } from "./settings";
import {
  recordAiRun,
  reserveAiBudget,
  settleAiBudget,
  type AiCost,
} from "./ai-usage";

const executionContext = new AsyncLocalStorage<AiTaskContext>();
export function currentAiContext(): AiTaskContext | undefined {
  return executionContext.getStore();
}
export function withAiContext<T>(context: AiTaskContext, fn: () => T): T {
  return executionContext.run(
    { ...executionContext.getStore(), ...context },
    fn,
  );
}
export interface RoutedAiRequest {
  task: AiTaskId;
  agent: AgentId;
  prompt: string;
  system: string;
  schema: Record<string, unknown>;
  model?: string;
  effort?: "low" | "medium" | "high";
  maxTurns?: number;
  timeoutMs?: number;
  context?: AiTaskContext;
  parameters?: Record<string, unknown>;
  validate?: (data: unknown) => boolean;
}
export interface RoutedAiResult {
  data: unknown;
  costUsd?: number;
  cost: AiCost;
  usage?: { inputTokens: number; outputTokens: number };
  cached?: boolean;
  requests?: number;
  actualModel?: string;
}
export type AiAdapter = (
  agent: AgentId,
  prompt: string,
  options: {
    model: string;
    system: string;
    schema: Record<string, unknown>;
    effort?: "low" | "medium" | "high";
    maxTurns: number;
    timeoutMs: number;
    maxBudgetUsd: number;
    retryLimit: number;
  },
) => Promise<RoutedAiResult>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function aiCacheIdentity(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}
/** All provider requests enter here, including standalone CLI workflows and existing Stories calls. */
export async function routeAiTask(
  request: RoutedAiRequest,
  adapter: AiAdapter,
  store: Store = runtimeStore(),
): Promise<RoutedAiResult> {
  const context = {
    ...executionContext.getStore(),
    ...request.context,
    agent: request.agent,
    model: request.model,
  };
  context.settings ??= loadSettings().aiRouting;
  const policy = resolveAiTask(request.task, context);
  if (policy.provider === "local")
    throw Error(
      "This task uses a local deterministic adapter, not a model prompt",
    );
  const inputBytes = Buffer.byteLength(
    request.prompt + request.system + JSON.stringify(request.schema),
    "utf8",
  );
  if (inputBytes > policy.contextLimit)
    throw Error(
      `${request.task} context exceeds ${policy.contextLimit} bytes; select a smaller clip or split the transcript`,
    );
  const cacheIdentity = aiCacheIdentity({
    task: request.task,
    inputVersion: context.inputVersion ?? "content-hash",
    prompt: request.prompt,
    system: request.system,
    schema: request.schema,
    model: policy.model,
    provider: policy.provider,
    escalation: policy.escalation,
    policyVersion: policy.policyVersion,
    parameters: request.parameters,
    effort: request.effort ?? "low",
    maxTurns: request.maxTurns ?? 1,
    outputLimit: policy.outputLimit,
  });
  const validator = z.fromJSONSchema(request.schema);
  const validate = (data: unknown) =>
    validator.safeParse(data).success &&
    (!request.validate || request.validate(data));
  // An explicitly requested health check must test the current adapter, never a cached reply.
  const cached =
    request.task === "diagnostic"
      ? undefined
      : store.get<{ data: unknown }>("ai-cache", cacheIdentity)?.value;
  if (cached && validate(cached.data)) {
    await recordAiRun(
      {
        runId: randomUUID(),
        task: request.task,
        inputVersion: context.inputVersion ?? cacheIdentity,
        provider: policy.provider,
        model: policy.model,
        routingReason: "Task-scoped cache",
        attempt: 0,
        latencyMs: 0,
        cost: { basis: "reported", value: 0 },
        outcome: "cache",
        cacheIdentity,
        at: Date.now(),
      },
      store,
    );
    return {
      data: cached.data,
      costUsd: 0,
      cost: { basis: "reported", value: 0 },
      cached: true,
    };
  }
  const routes: { agent: AgentId; model: string }[] = Array.from(
    { length: 1 + policy.retryLimit },
    () => ({ agent: policy.provider as AgentId, model: policy.model }),
  );
  if (policy.escalation) routes.push(policy.escalation);
  const maxTurns = Math.min(request.maxTurns ?? 1, 3);
  // SDK turns are potential provider requests too, even when application retries are bounded.
  const turnAllowance = Math.max(maxTurns, 1);
  const reservation = await reserveAiBudget(
    {
      key:
        context.idempotencyKey ??
        (context.jobId
          ? aiCacheIdentity({
              jobId: context.jobId,
              inputVersion: context.inputVersion,
              cacheIdentity,
            })
          : randomUUID()),
      jobId: context.jobId ?? `standalone:${cacheIdentity}`,
      task: request.task,
      ceilingUsd: policy.attemptCeilingUsd * routes.length,
      requests: routes.length * turnAllowance,
      tokens:
        (inputBytes + policy.outputLimit * 4) * routes.length * turnAllowance,
      ...budgetLimits(policy),
    },
    store,
  );
  let totalCost = 0;
  let unknown = false;
  let tokens = 0;
  let attempts = 0;
  let actualRequests = 0;
  let lastError: unknown;
  const deadline =
    Date.now() +
    Math.min(request.timeoutMs ?? policy.timeoutMs, policy.timeoutMs);
  try {
    for (const route of routes) {
      if (Date.now() >= deadline) throw Error("AI task deadline exhausted");
      const start = Date.now();
      attempts++;
      let result: RoutedAiResult | undefined;
      try {
        result = await adapter(
          route.agent,
          request.prompt + `\nOutput ceiling: ${policy.outputLimit} tokens.`,
          {
            model: route.model,
            system: request.system,
            schema: request.schema,
            effort: request.effort ?? "low",
            maxTurns,
            timeoutMs: deadline - Date.now(),
            maxBudgetUsd: policy.attemptCeilingUsd,
            retryLimit: 0,
          },
        );
        actualRequests += result.requests ?? turnAllowance;
        if (result.cost.basis === "unknown" || result.cost.value === undefined)
          unknown = true;
        else totalCost += result.cost.value;
        tokens += result.usage
          ? result.usage.inputTokens + result.usage.outputTokens
          : inputBytes + Buffer.byteLength(JSON.stringify(result.data) ?? "");
        if (
          Buffer.byteLength(JSON.stringify(result.data) ?? "") >
            policy.outputLimit * 4 ||
          !validate(result.data)
        )
          throw Error(
            "AI response failed task schema/coverage validation; needs review",
          );
        await recordAiRun(
          {
            runId: randomUUID(),
            task: request.task,
            inputVersion: context.inputVersion ?? cacheIdentity,
            provider: route.agent,
            model: route.model,
            actualModel: result?.actualModel,
            routingReason:
              attempts > 1
                ? "Bounded retry or configured escalation"
                : policy.reason,
            attempt: attempts,
            latencyMs: Date.now() - start,
            cost: result.cost,
            outcome: "success",
            cacheIdentity,
            reservationId: reservation.id,
            usage: result.usage,
            at: Date.now(),
          },
          store,
        );
        if (request.task !== "diagnostic")
          store.put("ai-cache", cacheIdentity, {
            data: result.data,
            createdAt: Date.now(),
            actualModel: route.model,
          });
        return {
          ...result,
          costUsd: unknown ? undefined : totalCost,
          cost: {
            basis: unknown ? "unknown" : "estimated",
            ...(unknown ? {} : { value: totalCost }),
          },
        };
      } catch (error) {
        // A failed transport may have spent money; preserve its full unknown allowance.
        if (!result) {
          unknown = true;
          actualRequests += turnAllowance;
        }
        lastError = error;
        await recordAiRun(
          {
            runId: randomUUID(),
            task: request.task,
            inputVersion: context.inputVersion ?? cacheIdentity,
            provider: route.agent,
            model: route.model,
            actualModel: result?.actualModel,
            routingReason: policy.reason,
            attempt: attempts,
            latencyMs: Date.now() - start,
            cost: result?.cost ?? { basis: "unknown" },
            outcome: "failed",
            cacheIdentity,
            reservationId: reservation.id,
            at: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          },
          store,
        );
        if (
          error instanceof Error &&
          (error.name === "CancelledError" ||
            /login|auth|not installed/i.test(error.message))
        )
          throw error;
      }
    }
    throw lastError ?? Error("AI task unavailable; needs review");
  } finally {
    await settleAiBudget(
      reservation.id,
      {
        basis: unknown ? "unknown" : "estimated",
        ...(unknown ? {} : { value: totalCost }),
      },
      actualRequests,
      tokens,
      store,
    );
  }
}
function budgetLimits(policy: AiTaskPolicy) {
  return {
    maxJobUsd: policy.maxJobUsd,
    maxDayUsd: policy.maxDayUsd,
    maxDayRequests: policy.maxDayRequests,
    maxDayTokens: policy.maxDayTokens,
  };
}
