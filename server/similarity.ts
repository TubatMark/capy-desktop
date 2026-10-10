import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { askAgent, type AskOpts } from "../src/agents";
import { DEFAULT_AI_ROUTING, type AiRoutingSettings } from "../lib/ai-policy";
import { queueGroup, queueLink } from "../lib/queue-source";
import {
  SIMILARITY_AGENTS,
  SIMILARITY_AGENT_NAME,
  SIMILARITY_LEVELS,
  SIMILARITY_POOL_DAYS,
  SIMILARITY_STORE,
  mergeOpinions,
  normalizeVerdicts,
  prePass,
  similarityGroups,
  type ClipFacts,
  type ClipSimilarity,
  type SimilarCandidate,
  type SimilarClipRef,
  type SimilarityAgent,
  type SimilarityGroup,
  type SimilarityOpinion,
} from "../lib/similarity";
import type { JobState, QueueEntry, Word } from "../lib/types";
import type { Store } from "./db";
import { runtimeStore } from "./db/runtime";
import { OUTPUT_ROOT } from "./paths";
import { queue } from "./queue";
import { loadSettings } from "./settings";
import { enqueueWork, type WorkInput } from "./worker/api";
import { registerWork } from "./worker/registry";

/**
 * The "Similar clips" check (see lib/similarity.ts for the pure parts). The worker's maintenance pass runs a cheap
 * pre-pass every 30 seconds and queues a "similarity" work item only for groups whose compared set changed; that work
 * asks Claude and Codex independently and stores one record per waiting clip in the runtime store
 * (kind "clip-similarity", id = queue group), which publicQueueEntry attaches to the entry. Nothing here ever blocks
 * an approval: a failed AI is recorded as unavailable.
 */

export { SIMILARITY_STORE };
const DAY = 86_400_000;
/** A queued check that never finished stops showing "Checking…" (and may be queued again) after this long. */
const CHECK_STALE_MS = 10 * 60_000;

export function storedSimilarity(
  id: string,
  store: Store = runtimeStore(),
): ClipSimilarity | undefined {
  return store.get<ClipSimilarity>(SIMILARITY_STORE, id)?.value;
}

// ---------- facts ----------

function stateOf(e: QueueEntry, since: number): ClipFacts["state"] | undefined {
  const recent = (e.slotAt ?? e.updatedAt) >= since;
  switch (e.status) {
    case "review":
      return "waiting";
    case "scheduled":
    case "posting":
    case "failed":
      return "scheduled";
    case "posted":
      return recent ? "posted" : undefined;
    case "needs_action":
      return e.result?.id ? (recent ? "posted" : undefined) : "scheduled";
    default:
      return undefined;
  }
}

const fpRange = (fp: string | undefined) => {
  const m = fp?.match(/^(\d+)-(\d+)$/);
  return m ? { start: Number(m[1]) / 10, end: Number(m[2]) / 10 } : {};
};

/**
 * One ClipFacts per queue group that is waiting, scheduled, or went out in the last 14 days. The source video,
 * channel and hook come from the job when it is still known; everything else from the queue entry.
 */
export function clipFacts(
  entries: QueueEntry[],
  now: number,
  store: Store = runtimeStore(),
): ClipFacts[] {
  const since = now - SIMILARITY_POOL_DAYS * DAY;
  const groups = new Map<string, { es: QueueEntry[]; states: Set<string> }>();
  for (const e of entries) {
    const state = stateOf(e, since);
    if (!state) continue;
    const id = queueGroup(e);
    const g = groups.get(id) ?? { es: [], states: new Set() };
    g.es.push(e);
    g.states.add(state);
    groups.set(id, g);
  }
  const jobs = new Map<string, JobState | undefined>();
  const job = (id: string | undefined) => {
    if (!id) return undefined;
    if (!jobs.has(id))
      jobs.set(id, store.get<JobState>("legacy-jobs", id)?.value);
    return jobs.get(id);
  };
  const out: ClipFacts[] = [];
  for (const [id, { es, states }] of groups) {
    const yt = es.find((e) => e.platform === "youtube");
    const first = yt ?? es[0]!;
    const j = job(first.jobId);
    const c = j?.clips.find((x) => x.n === first.n);
    const range = c ? { start: c.start, end: c.end } : fpRange(first.fp);
    const postTitle =
      yt?.text.title ??
      es.map((e) => e.text.caption?.split("\n")[0]).find(Boolean);
    out.push({
      id,
      state: states.has("waiting")
        ? "waiting"
        : states.has("posted")
          ? "posted"
          : "scheduled",
      title: first.clipTitle,
      ...(postTitle && postTitle !== first.clipTitle ? { postTitle } : {}),
      ...(c?.hook ? { hook: c.hook } : {}),
      ...(yt?.text.description || first.text.caption
        ? { description: (yt?.text.description ?? first.text.caption)! }
        : {}),
      source: first.source
        ? `studio:${first.source.projectId}`
        : j?.videoId
          ? `yt:${j.videoId}`
          : first.jobId
            ? `job:${first.jobId}`
            : undefined,
      ...(first.videoTitle ?? j?.title
        ? { videoTitle: first.videoTitle ?? j?.title }
        : {}),
      ...(j?.channel ? { channel: j.channel } : {}),
      ...range,
      at: Math.min(...es.map((e) => e.slotAt ?? e.createdAt)),
      ...(first.thumbUrl ? { thumbUrl: first.thumbUrl } : {}),
      link: queueLink(first),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** What the AIs compare; a change to any of it means a new check. Status changes alone don't. */
export function similaritySetHash(members: ClipFacts[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...members]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((f) => [
            f.id,
            f.source,
            f.start,
            f.end,
            f.title,
            f.postTitle,
            f.hook,
            f.description,
          ]),
      ),
    )
    .digest("hex");
}

/** A short excerpt of the clip's spoken words (from the job's transcript), when it is on disk. */
async function transcriptExcerpt(
  f: ClipFacts,
  store: Store,
): Promise<string | undefined> {
  const jobId = f.id.startsWith("studio:") ? undefined : f.id.split(":")[0];
  const j = jobId
    ? store.get<JobState>("legacy-jobs", jobId)?.value
    : undefined;
  if (!j?.dir || f.start === undefined || f.end === undefined) return undefined;
  try {
    const ws = JSON.parse(
      await readFile(path.join(OUTPUT_ROOT, j.dir, "words.json"), "utf8"),
    ) as Word[];
    const text = ws
      .filter((w) => w.start >= f.start! - 0.1 && w.start < f.end!)
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text ? text.slice(0, 280) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- the AI question ----------

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      clip: z.string().describe("The clip label, e.g. C1"),
      level: z.enum(SIMILARITY_LEVELS),
      similarTo: z
        .array(z.string())
        .describe("Labels of the clips it resembles; empty when distinct"),
      why: z.string().describe("One plain sentence"),
      recommendation: z
        .string()
        .describe("One concrete sentence; name clips by title, not label"),
    }),
  ),
});

export const SIMILARITY_SYSTEM =
  "You help a channel owner avoid posting near-identical short videos. Compare the clips you are given and answer only with the requested JSON.";

const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const STATE_WORD: Record<ClipFacts["state"], string> = {
  waiting: "WAITING",
  scheduled: "SCHEDULED",
  posted: "POSTED",
};

/** The prompt for one group; `labels` maps C1.. back to queue groups. */
export function buildSimilarityPrompt(
  members: ClipFacts[],
  candidates: Record<string, SimilarCandidate[]>,
): { prompt: string; labels: Record<string, string> } {
  const label = new Map(members.map((f, i) => [f.id, `C${i + 1}`]));
  const labels = Object.fromEntries(
    [...label.entries()].map(([id, l]) => [l, id]),
  );
  const q = (s: string | undefined, max: number) =>
    s ? `"${s.replace(/\s+/g, " ").trim().slice(0, max)}"` : "";
  const blocks = members.map((f) => {
    const lines = [`${label.get(f.id)} [${STATE_WORD[f.state]}] ${q(f.title, 120)}`];
    if (f.postTitle) lines.push(`  Posts as: ${q(f.postTitle, 120)}`);
    if (f.hook) lines.push(`  On-screen hook: ${q(f.hook, 120)}`);
    const from = [
      f.videoTitle ? `From ${q(f.videoTitle, 120)}` : "From an unknown video",
      f.channel ? `by ${f.channel}` : "",
      f.start !== undefined && f.end !== undefined
        ? `at ${clock(f.start)}-${clock(f.end)}`
        : "",
      f.source ? `(source ${f.source})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`  ${from}`);
    if (f.description) lines.push(`  Description: ${q(f.description, 200)}`);
    if (f.transcript) lines.push(`  Words spoken: ${q(f.transcript, 280)}`);
    const near = (candidates[f.id] ?? [])
      .filter((c) => label.has(c.id) && c.reasons.length)
      .map((c) => `${label.get(c.id)} (${c.reasons.join(", ").toLowerCase()})`);
    if (near.length) lines.push(`  Quick check found it close to: ${near.join("; ")}`);
    return lines.join("\n");
  });
  const waiting = members.filter((f) => f.state === "waiting");
  const prompt = `These short vertical clips go out on the same channel (YouTube Shorts, Instagram Reels, TikTok). Viewers scrolling the channel should not feel they are watching the same clip twice.

WAITING = waiting for the owner's OK (needs your verdict). SCHEDULED = already approved. POSTED = went out in the last ${SIMILARITY_POOL_DAYS} days.

${blocks.join("\n\n")}

For each WAITING clip (${waiting.map((f) => label.get(f.id)).join(", ")}), compare it with every other clip above:
- "near-duplicate": a viewer would feel they saw the same clip (same moment, same joke or story, same look).
- "similar": same source, setting or topic, but a different moment that can stand on its own if spaced out.
- "distinct": clearly different.
similarTo: labels of the clips it resembles (empty when distinct).
why: one plain sentence.
recommendation: one concrete sentence the owner can act on. Name clips by their title in quotes, never by label. Examples: "Post only the strongest one: 'X'; reject the others.", "Space them at least 2 days apart.", "Fine to post." Say so if a similar clip is already scheduled or posted.
Give exactly one verdict per WAITING clip.`;
  return { prompt, labels };
}

export type SimilarityAsk = (
  agent: SimilarityAgent,
  prompt: string,
  o: AskOpts,
) => Promise<{ data: unknown }>;

/**
 * The saved AI routing with the review task pointed at this agent: the owner asked for Claude and Codex both, so a
 * review route set to one of them must not turn the other opinion into a second copy of it. The agent's own task
 * model is kept when the review route already names that agent; budgets and the cloud switch are untouched.
 */
export function routingFor(
  agent: SimilarityAgent,
  base: AiRoutingSettings = loadSettings().aiRouting ?? DEFAULT_AI_ROUTING,
): AiRoutingSettings {
  const current = base.tasks.review;
  return {
    ...base,
    tasks: {
      ...base.tasks,
      review:
        current?.agent === agent
          ? { ...current, escalation: undefined }
          : { agent, premium: false },
    },
  };
}

/** Why an AI couldn't give its opinion, in words for the card. */
export function unavailableReason(agent: SimilarityAgent, e: unknown): string {
  const name = SIMILARITY_AGENT_NAME[agent];
  const m = e instanceof Error ? e.message : String(e);
  if (/not installed/i.test(m)) return `${name} isn't installed on this computer`;
  if (/AI budget exhausted/i.test(m))
    return m.replace(/^AI budget exhausted:\s*/i, "").replace(/\s*\(.*\)$/, "");
  if (/cloud ai is disabled/i.test(m)) return "AI is turned off in Settings";
  if (/log ?in|auth/i.test(m)) return `${name} needs you to log in again`;
  if (/did not answer within|deadline|timed out/i.test(m))
    return `${name} didn't answer in time`;
  return `${name} couldn't answer`;
}

async function askGroup(
  agent: SimilarityAgent,
  prompt: string,
  labels: Record<string, string>,
  waiting: string[],
  ask: SimilarityAsk,
): Promise<Record<string, SimilarityOpinion>> {
  const { $schema: _d, ...schema } = z.toJSONSchema(VerdictSchema, {
    target: "draft-7",
  }) as Record<string, unknown>;
  const need = Object.entries(labels)
    .filter(([, id]) => waiting.includes(id))
    .map(([l]) => l);
  const res = await ask(agent, prompt, {
    task: "review",
    context: { settings: routingFor(agent) },
    maxTurns: 2,
    effort: "low",
    timeoutMs: 120_000,
    system: SIMILARITY_SYSTEM,
    schema,
    validate: (data) => {
      const parsed = VerdictSchema.safeParse(data);
      if (!parsed.success) return false;
      const got = new Set(
        parsed.data.verdicts.map((v) => v.clip.trim().toUpperCase()),
      );
      return need.every((l) => got.has(l));
    },
  });
  return normalizeVerdicts(res.data, labels, waiting, agent);
}

// ---------- running a check ----------

const ref = (
  c: SimilarCandidate,
  byId: Map<string, ClipFacts>,
): SimilarClipRef | undefined => {
  const f = byId.get(c.id);
  return f
    ? {
        ...c,
        title: f.title,
        state: f.state,
        link: f.link,
        ...(f.thumbUrl ? { thumbUrl: f.thumbUrl } : {}),
      }
    : undefined;
};

function aloneRecord(f: ClipFacts, now: number): ClipSimilarity {
  return {
    checkedAt: now,
    setHash: similaritySetHash([f]),
    candidates: [],
    opinions: [],
    unavailable: [],
    verdict: mergeOpinions([], false),
  };
}

export interface SimilarityDeps {
  store?: Store;
  now?: () => number;
  ask?: SimilarityAsk;
  entries?: QueueEntry[];
  /** Writes go through this (the worker's lease fence). */
  write?: <T>(fn: () => T) => T;
}

/** Asks both AIs about one group and builds the record for each of its waiting clips. Never throws for an AI failure. */
export async function checkGroup(
  g: SimilarityGroup,
  facts: ClipFacts[],
  deps: SimilarityDeps = {},
): Promise<Record<string, ClipSimilarity>> {
  const store = deps.store ?? runtimeStore();
  const now = deps.now ?? Date.now;
  const ask = deps.ask ?? ((agent, prompt, o) => askAgent(agent, prompt, o));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const members = g.members.map((id) => byId.get(id)!).filter(Boolean);
  const setHash = similaritySetHash(members);
  const withWords = await Promise.all(
    members.map(async (f) => ({
      ...f,
      transcript: f.transcript ?? (await transcriptExcerpt(f, store)),
    })),
  );
  const { prompt, labels } = buildSimilarityPrompt(withWords, g.candidates);
  const answers = await Promise.allSettled(
    SIMILARITY_AGENTS.map((agent) =>
      askGroup(agent, prompt, labels, g.waiting, ask),
    ),
  );
  const at = now();
  const out: Record<string, ClipSimilarity> = {};
  for (const id of g.waiting) {
    const opinions: SimilarityOpinion[] = [];
    const unavailable: ClipSimilarity["unavailable"] = [];
    answers.forEach((a, i) => {
      const agent = SIMILARITY_AGENTS[i]!;
      if (a.status === "rejected")
        unavailable.push({ by: agent, reason: unavailableReason(agent, a.reason) });
      else if (a.value[id]) opinions.push(a.value[id]!);
      else
        unavailable.push({
          by: agent,
          reason: `${SIMILARITY_AGENT_NAME[agent]} didn't give an answer for this clip`,
        });
    });
    // the pre-pass matches, plus any clip an AI linked that the pre-pass ranked lower
    const linked = new Map(
      (g.candidates[id] ?? []).map((c) => [c.id, c] as const),
    );
    for (const o of opinions)
      for (const other of o.similarTo)
        if (!linked.has(other) && byId.has(other))
          linked.set(other, {
            id: other,
            ...prePass(byId.get(id)!, byId.get(other)!),
          });
    out[id] = {
      checkedAt: at,
      setHash,
      candidates: [...linked.values()]
        .map((c) => ref(c, byId))
        .filter((c): c is SimilarClipRef => !!c),
      opinions,
      unavailable,
      verdict: mergeOpinions(opinions, true),
    };
  }
  return out;
}

/**
 * The work item: re-checks the groups holding `targets` (waiting clips), from the queue as it is now. Without
 * `force`, a group whose set is unchanged since its last check is left alone.
 */
export async function runSimilarityCheck(
  payload: { targets: string[]; force?: boolean },
  deps: SimilarityDeps = {},
): Promise<void> {
  const store = deps.store ?? runtimeStore();
  const now = deps.now ?? Date.now;
  const write = deps.write ?? (<T,>(fn: () => T) => fn());
  const facts = clipFacts(deps.entries ?? queue().list(), now(), store);
  const byId = new Map(facts.map((f) => [f.id, f]));
  const { groups, alone } = similarityGroups(facts);
  const targets = new Set(payload.targets);
  const done = new Set<string>();
  for (const id of alone)
    if (targets.has(id)) {
      write(() => store.put(SIMILARITY_STORE, id, aloneRecord(byId.get(id)!, now())));
      done.add(id);
    }
  for (const g of groups) {
    if (!g.waiting.some((id) => targets.has(id))) continue;
    const hash = similaritySetHash(g.members.map((id) => byId.get(id)!));
    const fresh = g.waiting.every((id) => {
      const s = storedSimilarity(id, store);
      return s?.setHash === hash && s.checkedAt > 0;
    });
    if (fresh && !payload.force) {
      write(() => {
        for (const id of g.waiting) clearChecking(id, store);
      });
      g.waiting.forEach((id) => done.add(id));
      continue;
    }
    // a forced re-check runs under a new work revision, so the AI router's answer cache doesn't replay the old one
    const records = await checkGroup(g, facts, { ...deps, store });
    write(() => {
      for (const [id, r] of Object.entries(records))
        store.put(SIMILARITY_STORE, id, r);
    });
    g.waiting.forEach((id) => done.add(id));
  }
  // targets that are no longer waiting: stop showing "Checking…"
  write(() => {
    for (const id of targets) if (!done.has(id)) clearChecking(id, store);
  });
}

function clearChecking(id: string, store: Store) {
  const s = storedSimilarity(id, store);
  if (s?.checking === undefined) return;
  const { checking: _c, ...rest } = s;
  store.put(SIMILARITY_STORE, id, rest);
}

function markChecking(
  ids: string[],
  at: number,
  store: Store,
  candidates: Record<string, SimilarClipRef[]> = {},
) {
  for (const id of ids)
    store.put(SIMILARITY_STORE, id, {
      ...(storedSimilarity(id, store) ?? {
        checkedAt: 0,
        setHash: "",
        candidates: candidates[id] ?? [],
        opinions: [],
        unavailable: [],
        verdict: mergeOpinions([], true),
      }),
      checking: at,
    } satisfies ClipSimilarity);
}

const revisionOf = (s: string) =>
  parseInt(createHash("sha256").update(s).digest("hex").slice(0, 12), 16);

/**
 * The cheap pass (worker maintenance): settles clips nothing is close to, and queues one AI check per group whose
 * compared set changed since its last check. Returns how many checks it queued.
 */
export async function similaritySweep(
  deps: SimilarityDeps & { enqueue?: (w: WorkInput) => Promise<unknown> } = {},
): Promise<number> {
  const store = deps.store ?? runtimeStore();
  const now = (deps.now ?? Date.now)();
  const enqueue = deps.enqueue ?? enqueueWork;
  const facts = clipFacts(deps.entries ?? queue().list(), now, store);
  const byId = new Map(facts.map((f) => [f.id, f]));
  const { groups, alone } = similarityGroups(facts);
  for (const id of alone) {
    const s = storedSimilarity(id, store);
    const r = aloneRecord(byId.get(id)!, now);
    if (s?.setHash !== r.setHash || s.checking !== undefined)
      store.put(SIMILARITY_STORE, id, r);
  }
  let queued = 0;
  for (const g of groups) {
    const hash = similaritySetHash(g.members.map((id) => byId.get(id)!));
    const stored = g.waiting.map((id) => storedSimilarity(id, store));
    const stale = stored.some(
      (s) =>
        (s?.setHash !== hash || !s.checkedAt) &&
        !(s?.checking !== undefined && now - s.checking < CHECK_STALE_MS),
    );
    if (!stale) continue;
    await enqueue({
      kind: "similarity",
      workKey: `similarity:${hash.slice(0, 32)}`,
      // the same set seen again after a different one gets a fresh run
      inputRevision: revisionOf(
        hash + JSON.stringify(stored.map((s) => s?.setHash ?? "")),
      ),
      payload: { targets: g.waiting },
    });
    markChecking(
      g.waiting,
      now,
      store,
      Object.fromEntries(
        g.waiting.map((id) => [
          id,
          (g.candidates[id] ?? [])
            .map((c) => ref(c, byId))
            .filter((c): c is SimilarClipRef => !!c),
        ]),
      ),
    );
    queued++;
  }
  return queued;
}

/** "Check again" on one clip: re-asks both AIs about its group, even when nothing changed. */
export async function requestSimilarityCheck(
  entry: QueueEntry,
  deps: { store?: Store; now?: number; enqueue?: (w: WorkInput) => Promise<unknown> } = {},
): Promise<ClipSimilarity | undefined> {
  const store = deps.store ?? runtimeStore();
  const now = deps.now ?? Date.now();
  const id = queueGroup(entry);
  await (deps.enqueue ?? enqueueWork)({
    kind: "similarity",
    workKey: `similarity:recheck:${id}`,
    inputRevision: now,
    payload: { targets: [id], force: true },
  });
  markChecking([id], now, store);
  return storedSimilarity(id, store);
}

export function registerSimilarityWorkers() {
  registerWork("similarity", (lease) => [
    {
      name: "comparing",
      ai: true,
      timeoutMs: 6 * 60_000,
      run: async (ctx) => {
        const p = lease.payload as {
          targets?: unknown;
          force?: unknown;
        };
        await runSimilarityCheck(
          {
            targets: Array.isArray(p.targets) ? p.targets.map(String) : [],
            force: p.force === true,
          },
          { write: ctx.fenced },
        );
      },
    },
  ]);
}

let lastSweep = 0;
/** Maintenance hook: at most one pre-pass every 30 seconds. */
export async function maybeSweepSimilarity(now = Date.now()) {
  if (now - lastSweep < 30_000) return;
  lastSweep = now;
  await similaritySweep().catch((e) =>
    console.error("[similarity]", e instanceof Error ? e.message : e),
  );
}
