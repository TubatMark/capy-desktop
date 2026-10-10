import { z } from "zod";
import type { AgentId } from "./types";

export const AI_TASKS = [
  "transcription",
  "selection",
  "translation",
  "metadata",
  "review",
  "vision",
  "thumbnail-generation",
  "edit-assistance",
  "performance-summary",
  "diagnostic",
] as const;
export type AiTaskId = (typeof AI_TASKS)[number];
export type DeterministicTask =
  "resize" | "cut" | "schedule" | "thumbnail-text";
export type AiModality = "text" | "image" | "audio" | "image-generation";
export const AdapterRouteSchema = z.strictObject({
  agent: z.enum([
    "claude",
    "codex",
    "gemini",
    "qwen",
    "cursor",
    "opencode",
    "droid",
    "copilot",
    "amp",
  ]),
  model: z.string().trim().min(1).max(200),
});
export const AiRouteSchema = AdapterRouteSchema.extend({
  premium: z.boolean().default(false),
  escalation: AdapterRouteSchema.optional(),
});
export const AiRoutingSchema = z.strictObject({
  version: z.literal(1),
  allowCloud: z.boolean(),
  allowPremiumImages: z.boolean(),
  maxJobUsd: z.number().finite().min(0).max(100),
  maxDayUsd: z.number().finite().min(0).max(1000),
  maxDayRequests: z.number().int().min(0).max(10000),
  maxDayTokens: z.number().int().min(0).max(100000000),
  retryLimit: z.number().int().min(0).max(1),
  tasks: z.partialRecord(z.enum(AI_TASKS), AiRouteSchema),
});
export type AiRoutingSettings = z.infer<typeof AiRoutingSchema>;
export const DEFAULT_AI_ROUTING: AiRoutingSettings = {
  version: 1,
  allowCloud: true,
  allowPremiumImages: false,
  maxJobUsd: 1,
  maxDayUsd: 5,
  maxDayRequests: 40,
  maxDayTokens: 500000,
  retryLimit: 1,
  tasks: {},
};
/** These are transport capabilities, independent of the provider's model marketing. */
export const AI_ADAPTER_CAPABILITIES: Record<
  AgentId,
  {
    modalities: AiModality[];
    local: boolean;
    modelSelection: boolean;
    tokenReporting: boolean;
  }
> = {
  claude: {
    modalities: ["text"],
    local: false,
    modelSelection: true,
    tokenReporting: true,
  },
  codex: {
    modalities: ["text"],
    local: false,
    modelSelection: true,
    tokenReporting: false,
  },
  gemini: {
    modalities: ["text"],
    local: false,
    modelSelection: true,
    tokenReporting: false,
  },
  qwen: {
    modalities: ["text"],
    local: false,
    modelSelection: true,
    tokenReporting: false,
  },
  cursor: {
    modalities: ["text"],
    local: false,
    modelSelection: true,
    tokenReporting: false,
  },
  opencode: {
    modalities: ["text"],
    local: false,
    modelSelection: true,
    tokenReporting: false,
  },
  droid: {
    modalities: ["text"],
    local: false,
    modelSelection: true,
    tokenReporting: false,
  },
  copilot: {
    modalities: ["text"],
    local: false,
    modelSelection: true,
    tokenReporting: false,
  },
  amp: {
    modalities: ["text"],
    local: false,
    modelSelection: false,
    tokenReporting: false,
  },
};
export interface AiTaskContext {
  jobId?: string;
  inputVersion?: string;
  idempotencyKey?: string;
  requiredModality?: AiModality;
  allowCloud?: boolean;
  allowLocal?: boolean;
  agent?: AgentId;
  /** A legacy selection model; simple tasks use their own assignment. */
  model?: string;
  settings?: AiRoutingSettings;
  creatorOverride?: Partial<Pick<AiRoutingSettings, "maxJobUsd" | "maxDayUsd">>;
  retryCount?: number;
  escalationCount?: number;
}
export interface AiTaskPolicy {
  task: AiTaskId | DeterministicTask;
  provider: AgentId | "local";
  model: string;
  modality: AiModality;
  contextLimit: number;
  outputLimit: number;
  timeoutMs: number;
  retryLimit: number;
  escalation?: z.infer<typeof AdapterRouteSchema>;
  maxJobUsd: number;
  maxDayUsd: number;
  maxDayRequests: number;
  maxDayTokens: number;
  attemptCeilingUsd: number;
  policyVersion: number;
  reason: string;
}
export function assertAiCapability(
  agent: AgentId,
  modality: AiModality,
  model: string,
  premium: boolean,
) {
  const cap = AI_ADAPTER_CAPABILITIES[agent];
  if (!cap.modalities.includes(modality))
    throw Error(`${agent} adapter capability does not support ${modality}`);
  if (!cap.modelSelection)
    throw Error(`${agent} adapter cannot enforce a model selection`);
  if (/(opus|astra|ultra)/i.test(model) && !premium)
    throw Error("Premium model requires an explicit task policy");
}
export function resolveAiTask(
  task: AiTaskId | DeterministicTask,
  context: AiTaskContext,
): AiTaskPolicy {
  const settings = context.settings ?? DEFAULT_AI_ROUTING;
  const limits = {
    maxJobUsd: Math.min(
      settings.maxJobUsd,
      context.creatorOverride?.maxJobUsd ?? Infinity,
    ),
    maxDayUsd: Math.min(
      settings.maxDayUsd,
      context.creatorOverride?.maxDayUsd ?? Infinity,
    ),
    maxDayRequests: settings.maxDayRequests,
    maxDayTokens: settings.maxDayTokens,
  };
  const base = {
    task,
    ...limits,
    policyVersion: settings.version,
    contextLimit: task === "selection" ? 80000 : 16000,
    outputLimit: task === "selection" ? 8000 : 4000,
    timeoutMs: task === "selection" ? 180000 : 120000,
    retryLimit: Math.max(
      0,
      settings.retryLimit - Math.max(0, context.retryCount ?? 0),
    ),
    attemptCeilingUsd: task === "selection" ? 0.25 : 0.1,
  };
  if (
    ["resize", "cut", "schedule", "thumbnail-text", "transcription"].includes(
      task,
    )
  ) {
    return {
      ...base,
      provider: "local",
      model: task === "transcription" ? "captions-or-local-whisper" : "none",
      modality: "text",
      retryLimit: 0,
      attemptCeilingUsd: 0,
      reason: "Deterministic local operation",
    };
  }
  const route = settings.tasks[task as AiTaskId];
  const agent = route?.agent ?? context.agent ?? "claude";
  const selection = task === "selection";
  const defaults: Partial<Record<AgentId, string>> = {
    claude: selection ? "claude-sonnet-5-5" : "claude-haiku-5-5",
    codex: selection ? "gpt-6-sol" : "gpt-6-luna",
    gemini: "gemini-3.5-flash-lite",
  };
  const model =
    route?.model ??
    (selection || task === "diagnostic" ? context.model : undefined) ??
    defaults[agent];
  const modality =
    context.requiredModality ??
    (task === "vision"
      ? "image"
      : task === "thumbnail-generation"
        ? "image-generation"
        : "text");
  if (!settings.allowCloud || context.allowCloud === false)
    throw Error(
      "Cloud AI is disabled; no compatible local model adapter configured",
    );
  if (!model)
    throw Error(
      `${agent} requires an explicit task model assignment; availability and price are unverified`,
    );
  assertAiCapability(agent, modality, model, route?.premium ?? false);
  if (
    task === "thumbnail-generation" &&
    route?.premium &&
    !settings.allowPremiumImages
  )
    throw Error("Premium image quality is disabled");
  const escalation =
    (context.escalationCount ?? 0) < 1 ? route?.escalation : undefined;
  if (escalation)
    assertAiCapability(
      escalation.agent,
      modality,
      escalation.model,
      route?.premium ?? false,
    );
  return {
    ...base,
    provider: agent,
    model,
    modality,
    escalation,
    reason: route
      ? "Explicit task assignment"
      : selection
        ? "Mid-tier selection candidate; quality not evaluated"
        : "Compact text candidate; quality not evaluated",
  };
}

export interface AiCost {
  value?: number;
  basis: "reported" | "estimated" | "unknown";
  currency?: "USD";
}
export interface AiRunRecord {
  runId: string;
  task: AiTaskId;
  inputVersion: string;
  provider: AgentId;
  model: string;
  actualModel?: string;
  routingReason: string;
  attempt: number;
  latencyMs: number;
  cost: AiCost;
  outcome: "success" | "failed" | "cache";
  cacheIdentity: string;
  reservationId?: string;
  at: number;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
