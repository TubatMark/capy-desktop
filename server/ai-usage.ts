import { randomUUID } from "node:crypto";
export type { AiCost, AiRunRecord } from "../lib/ai-policy";
import type { AiCost, AiRunRecord, AiTaskId } from "../lib/ai-policy";
import type { Store } from "./db";
import { runtimeStore } from "./db/runtime";
import { loadSettings } from "./settings";
import { DEFAULT_AI_ROUTING } from "../lib/ai-policy";
export interface AiBudgetRequest {
  key: string;
  jobId: string;
  task: AiTaskId;
  ceilingUsd: number;
  requests: number;
  tokens: number;
  maxJobUsd: number;
  maxDayUsd: number;
  maxDayRequests: number;
  maxDayTokens: number;
}
export interface AiBudgetReservation extends AiBudgetRequest {
  id: string;
  day: string;
  createdAt: number;
  state: "reserved" | "settled" | "orphaned";
}
interface Counter {
  usd: number;
  requests: number;
  tokens: number;
}
const zero = (): Counter => ({ usd: 0, requests: 0, tokens: 0 });
export class AiBudgetError extends Error {
  readonly code = "AI_BUDGET_EXHAUSTED";
}
function check(n: number, limit: number, label: string) {
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(limit) || limit < 0)
    throw Error(`Invalid AI ${label}`);
}
export async function reserveAiBudget(
  input: AiBudgetRequest,
  store: Store = runtimeStore(),
): Promise<AiBudgetReservation> {
  for (const [n, limit, label] of [
    [input.ceilingUsd, input.maxDayUsd, "cost"],
    [input.requests, input.maxDayRequests, "requests"],
    [input.tokens, input.maxDayTokens, "tokens"],
  ] as const)
    check(n, limit, label);
  check(input.ceilingUsd, input.maxJobUsd, "job cost");
  return store.transaction(() => {
    if (store.get("ai-reservation", input.key))
      throw Error(
        "AI reservation already exists; replay must use its durable result, never invoke a provider again",
      );
    const day = new Date().toISOString().slice(0, 10);
    const d = store.get<Counter>("ai-budget-day", day)?.value ?? zero();
    const j = store.get<Counter>("ai-budget-job", input.jobId)?.value ?? zero();
    if (
      d.usd + input.ceilingUsd > input.maxDayUsd + 1e-9 ||
      j.usd + input.ceilingUsd > input.maxJobUsd + 1e-9 ||
      d.requests + input.requests > input.maxDayRequests ||
      d.tokens + input.tokens > input.maxDayTokens
    )
      throw new AiBudgetError(
        "AI budget exhausted: task needs reserved day/job cost and subscription request/token allowance",
      );
    const r: AiBudgetReservation = {
      ...input,
      id: input.key,
      day,
      createdAt: Date.now(),
      state: "reserved",
    };
    for (const [kind, id, c] of [
      ["ai-budget-day", day, d],
      ["ai-budget-job", input.jobId, j],
    ] as const)
      store.put(kind, id, {
        usd: c.usd + input.ceilingUsd,
        requests: c.requests + input.requests,
        tokens: c.tokens + input.tokens,
      });
    store.put("ai-reservation", r.id, r);
    return r;
  });
}
export async function settleAiBudget(
  id: string,
  cost: AiCost,
  requests: number,
  tokens: number,
  store: Store = runtimeStore(),
): Promise<void> {
  store.transaction(() => {
    const r = store.get<AiBudgetReservation>("ai-reservation", id)?.value;
    if (!r || r.state !== "reserved") return;
    if (
      cost.basis !== "unknown" &&
      (cost.value === undefined ||
        !Number.isFinite(cost.value) ||
        cost.value < 0)
    )
      throw Error("Invalid AI cost receipt");
    check(requests, Number.MAX_SAFE_INTEGER, "actual requests");
    check(tokens, Number.MAX_SAFE_INTEGER, "actual tokens");
    const usd = cost.basis === "unknown" ? r.ceilingUsd : cost.value!;
    // Unknown token receipts retain the reserved token ceiling. Usage limits apply in subscription mode too.
    const chargedTokens =
      cost.basis === "unknown" ? Math.max(r.tokens, tokens) : tokens;
    for (const [kind, key] of [
      ["ai-budget-day", r.day],
      ["ai-budget-job", r.jobId],
    ]) {
      const c = store.get<Counter>(kind!, key!)!.value;
      store.put(kind!, key!, {
        usd: Math.max(0, c.usd - r.ceilingUsd + usd),
        requests: Math.max(0, c.requests - r.requests + requests),
        tokens: Math.max(0, c.tokens - r.tokens + chargedTokens),
      });
    }
    store.put("ai-reservation", id, {
      ...r,
      state: "settled",
      cost,
      settledAt: Date.now(),
    });
  });
}
export async function recordAiRun(
  run: AiRunRecord,
  store: Store = runtimeStore(),
): Promise<void> {
  store.transaction(() => {
    if (store.claim("ai-run", run.runId, run.runId))
      store.put("ai-run", run.runId, run);
  });
}
/** Worker recovery retains reservations whose cost is unknown; it never frees potentially spent allowance. */
export function recoverAiReservations(
  before: number,
  store: Store = runtimeStore(),
): number {
  return store.transaction(() => {
    let count = 0;
    for (const row of store.list<AiBudgetReservation>("ai-reservation"))
      if (row.value.state === "reserved" && row.value.createdAt < before) {
        store.put("ai-reservation", row.id, {
          ...row.value,
          state: "orphaned",
        });
        count++;
      }
    return count;
  });
}
export function getAiUsage(store: Store = runtimeStore()) {
  const day = new Date().toISOString().slice(0, 10);
  const runs = store
    .list<AiRunRecord>("ai-run")
    .map((r) => r.value)
    .filter((r) => new Date(r.at).toISOString().slice(0, 10) === day);
  const tasks = Object.entries(Object.groupBy(runs, (r) => r.task)).map(
    ([task, rows]) => ({
      task,
      calls: rows!.filter((r) => r.outcome !== "cache").length,
      cached: rows!.filter((r) => r.outcome === "cache").length,
      estimatedUsd: rows!.reduce((sum, r) => sum + (r.cost.value ?? 0), 0),
      unknown: rows!.filter((r) => r.cost.basis === "unknown").length,
    }),
  );
  return {
    day,
    ...(store.get<Counter>("ai-budget-day", day)?.value ?? zero()),
    tasks,
    pending: store
      .list<AiBudgetReservation>("ai-reservation")
      .filter((r) => r.value.state !== "settled").length,
  };
}
export function assertAiBudgetAvailable(
  jobId?: string,
  store: Store = runtimeStore(),
) {
  const limits = loadSettings().aiRouting ?? DEFAULT_AI_ROUTING;
  const usage = getAiUsage(store);
  const job = jobId
    ? store.get<Counter>("ai-budget-job", jobId)?.value
    : undefined;
  if (
    usage.usd >= limits.maxDayUsd ||
    usage.requests >= limits.maxDayRequests ||
    usage.tokens >= limits.maxDayTokens ||
    (job && job.usd >= limits.maxJobUsd)
  )
    throw new AiBudgetError(
      "AI budget exhausted; waiting for allowance or a settings change",
    );
}
export const newAiRunId = randomUUID;
