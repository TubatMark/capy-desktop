import { statfsSync } from "node:fs";
import {
  DEFAULT_CONTROLS,
  type AutomationHealth,
} from "../../lib/creator-policy";
import { runtimeStore } from "../db/runtime";
import { workQueue } from "./api";
import { loadSettings } from "../settings";
import { publicAccounts } from "../accounts";
import { getAiUsage } from "../ai-usage";
import { watch } from "../watch";
import { unsavedCreatorPolicy } from "../automation-policy";
import { queue } from "../queue";
import { OUTPUT_ROOT } from "../paths";
export async function automationHealth(): Promise<AutomationHealth> {
  const store = runtimeStore(),
    settings = loadSettings(),
    w = watch().get(),
    jobs = workQueue().list(),
    now = Date.now();
  const service = store.get<{ heartbeat: number; expiresAt: number }>(
    "worker",
    "service",
  )?.value;
  const online =
    !!service && service.expiresAt > now && now - service.heartbeat < 15000;
  const sourcePending = w.channels.flatMap((c) => c.pending),
    workPending = jobs.filter((j) =>
      ["queued", "running", "retryable", "blocked"].includes(j.status),
    );
  const timestamps = [
    ...sourcePending.map((v) => v.foundAt),
    ...workPending.map((j) => j.createdAt),
  ];
  const reserveBytes = Number(process.env.CAPY_DISK_RESERVE_BYTES ?? 1024 ** 3);
  let disk: AutomationHealth["disk"] = { reserveBytes };
  try {
    const fs = statfsSync(OUTPUT_ROOT);
    disk.availableBytes = fs.bavail * fs.bsize;
  } catch (error) {
    disk.error =
      error instanceof Error ? error.message : "Disk status unavailable";
  }
  const usage = getAiUsage();
  const decisions = store
    .list<{ candidateId: string; reason: string; kind: string; at: number }>(
      "automation-decisions",
    )
    .map((r) => r.value)
    .filter((v) => v.kind !== "proceed")
    .map((v) => ({ id: v.candidateId, reason: v.reason, at: v.at }));
  const blocked = jobs
    .filter((j) => ["blocked", "needs_action"].includes(j.status))
    .map((j) => ({
      id: j.id,
      reason: j.error ?? "Worker task needs attention",
      at: j.createdAt,
    }));
  const discovery = store
    .list<{
      videoId: string;
      status: string;
      reason: string;
      checkedAt?: number;
    }>("discovery-videos")
    .map((r) => r.value)
    .filter((v) => v.status !== "ready")
    .map((v) => ({ id: v.videoId, reason: v.reason, at: v.checkedAt ?? 0 }));
  const lastSuccessAt = store.get<{ lastSuccessAt: number }>(
    "automation-health",
    "worker",
  )?.value.lastSuccessAt;
  const scheduled = queue()
    .list()
    .filter((e) => e.status === "scheduled" && e.slotAt)
    .map((e) => e.slotAt!);
  return {
    online,
    heartbeat: service?.heartbeat,
    activeStage: online
      ? jobs.find((j) => j.status === "running" && j.expiresAt > now)?.stage
      : undefined,
    oldestPendingAt: timestamps.length ? Math.min(...timestamps) : undefined,
    lastSuccessAt,
    nextPostAt: scheduled.length ? Math.min(...scheduled) : undefined,
    pending: sourcePending.length + workPending.length,
    disk,
    budget: {
      reservedUsd: usage.usd,
      maxDayUsd: settings.aiRouting?.maxDayUsd ?? 0,
      requests: usage.requests,
      maxDayRequests: settings.aiRouting?.maxDayRequests ?? 0,
      unknown: usage.unknownUsageRuns,
    },
    accounts: publicAccounts().map((a) => ({
      id: a.account?.id,
      platform: a.platform,
      connected: a.connected,
      needsReconnect: !!a.needsReconnect,
    })),
    controls: {
      ...(settings.automationControls ?? DEFAULT_CONTROLS),
      postPaused:
        !!settings.postingPaused || !!settings.automationControls?.postPaused,
    },
    reasons: [...blocked, ...decisions, ...discovery]
      .sort((a, b) => b.at - a.at)
      .slice(0, 100),
    creatorNames: Object.fromEntries(w.channels.map((c) => [c.id, c.name])),
    policies: Object.fromEntries(
      w.channels.map((c) => [
        c.id,
        settings.creatorPolicies?.[c.id] ?? {
          ...unsavedCreatorPolicy(c),
          mode: c.enabled ? "automatic_drafts" : (c.mode ?? "manual"),
        },
      ]),
    ),
    publication: {
      enabled: false,
      reason:
        "Automatic publication is disabled pending a real 72-hour fault soak and separately authorized controlled upload",
    },
  };
}
