/**
 * "Similar clips": does a clip waiting for review look like another clip that is waiting, scheduled or recently
 * posted? A cheap word/time pre-pass picks candidates (and skips AI when nothing is close); two different AIs then
 * give independent verdicts that are merged here. Pure and browser-safe: the server (server/similarity.ts) and the
 * Queue UI both use it.
 */

export const SIMILARITY_LEVELS = [
  "distinct",
  "similar",
  "near-duplicate",
] as const;
export type SimilarityLevel = (typeof SIMILARITY_LEVELS)[number];
/** The two AIs asked for independent opinions. */
export const SIMILARITY_AGENTS = ["claude", "codex"] as const;
export type SimilarityAgent = (typeof SIMILARITY_AGENTS)[number];
export const SIMILARITY_AGENT_NAME: Record<SimilarityAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** Runtime-store kind holding one ClipSimilarity per queue group. */
export const SIMILARITY_STORE = "clip-similarity";
/** How far back posted clips count. */
export const SIMILARITY_POOL_DAYS = 14;
/** Pre-pass score from which a pair is worth an AI look. */
export const CANDIDATE_THRESHOLD = 0.35;

/** What the comparison knows about one clip (one queue group, all platforms together). */
export interface ClipFacts {
  /** queueGroup(entry) */
  id: string;
  state: "waiting" | "scheduled" | "posted";
  title: string;
  /** The title/caption it posts with, when different from the clip title. */
  postTitle?: string;
  hook?: string;
  description?: string;
  /** A short excerpt of the spoken words (filled in only right before an AI call). */
  transcript?: string;
  /** Source video identity (YouTube id, studio project, ...). */
  source?: string;
  videoTitle?: string;
  channel?: string;
  /** Seconds into the source video. */
  start?: number;
  end?: number;
  /** When it was made / is scheduled / went out (ms). */
  at: number;
  thumbUrl?: string;
  link: string;
}

export interface SimilarCandidate {
  id: string;
  /** 0..1 */
  score: number;
  reasons: string[];
}

/** A linked clip as the card shows it (a snapshot from the check). */
export interface SimilarClipRef extends SimilarCandidate {
  title: string;
  thumbUrl?: string;
  state: ClipFacts["state"];
  link: string;
}

export interface SimilarityOpinion {
  by: SimilarityAgent;
  level: SimilarityLevel;
  /** queue groups */
  similarTo: string[];
  why: string;
  recommendation: string;
}

export interface SimilarityVerdict {
  /** "unchecked": there were close clips but no AI could answer. */
  level: SimilarityLevel | "unchecked";
  /** agree/differ: both AIs answered; single: only one did; none: no AI was needed or none answered. */
  agreement: "agree" | "differ" | "single" | "none";
  similarTo: string[];
  why?: string;
  recommendation?: string;
}

export interface ClipSimilarity {
  checkedAt: number;
  /** Set while a check is queued or running (ms since). */
  checking?: number;
  /** Hash of the compared set: a different set means a new check. */
  setHash: string;
  candidates: SimilarClipRef[];
  opinions: SimilarityOpinion[];
  unavailable: { by: SimilarityAgent; reason: string }[];
  verdict: SimilarityVerdict;
}

// ---------- pre-pass ----------

const STOP = new Set(
  `a an the and or but of in on at to for with from by into onto over under about after before during
  is are was were be been being am it its this that these those he she they them his her their him you your
  i me my we our us so as if then than just very too also not no yes do does did done
  up out off down vs versus how why what who when where which while
  gets get got goes go going went makes make made takes take took has have had
  shorts short clip clips video videos full live stream moment moments part episode ep new official`
    .split(/\s+/)
    .filter(Boolean),
);

/** Content words: lowercase, accents kept, stop words and plural "s" dropped. */
export function words(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOP.has(raw)) continue;
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

const titleWords = (f: ClipFacts) =>
  words([f.title, f.postTitle, f.hook].filter(Boolean).join(" "));
const textWords = (f: ClipFacts) =>
  words([f.description, f.transcript].filter(Boolean).join(" "));

/** How close two clips look before any AI: same source, overlapping footage, similar titles or words. */
export function prePass(a: ClipFacts, b: ClipFacts): Omit<SimilarCandidate, "id"> {
  let score = 0;
  const reasons: string[] = [];
  const sameSource = !!a.source && a.source === b.source;
  if (sameSource) {
    score += 0.4;
    reasons.push("Cut from the same video");
    if (
      a.start !== undefined &&
      a.end !== undefined &&
      b.start !== undefined &&
      b.end !== undefined
    ) {
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      const shorter = Math.max(1, Math.min(a.end - a.start, b.end - b.start));
      if (overlap > 0) {
        const share = Math.min(1, overlap / shorter);
        score += 0.4 * share;
        reasons.push(
          share >= 0.5
            ? "Uses the same part of the video"
            : "Partly uses the same part of the video",
        );
      } else if (-overlap < 120) {
        score += 0.1;
        reasons.push("From moments close together in the video");
      }
    }
  } else if (
    a.channel &&
    b.channel &&
    a.channel.toLowerCase() === b.channel.toLowerCase()
  ) {
    score += 0.1;
  }
  const t = jaccard(titleWords(a), titleWords(b));
  score += 0.6 * t;
  if (t >= 0.3) reasons.push("Similar titles");
  const w = jaccard(textWords(a), textWords(b));
  if (w >= 0.3) {
    score += 0.2;
    reasons.push("Similar words");
  }
  if (!sameSource && score >= CANDIDATE_THRESHOLD && a.channel && a.channel === b.channel)
    reasons.push("Same creator");
  return { score: Math.min(1, Math.round(score * 100) / 100), reasons };
}

/** The clips in `pool` close enough to `target` to ask an AI about, closest first. */
export function similarityCandidates(
  target: ClipFacts,
  pool: ClipFacts[],
  max = 6,
): SimilarCandidate[] {
  return pool
    .filter((p) => p.id !== target.id)
    .map((p) => ({ id: p.id, ...prePass(target, p) }))
    .filter((c) => c.score >= CANDIDATE_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, max);
}

export interface SimilarityGroup {
  /** Waiting clips that get a verdict. */
  waiting: string[];
  /** Every clip shown to the AIs (waiting first). */
  members: string[];
  /** Pre-pass candidates per waiting clip. */
  candidates: Record<string, SimilarCandidate[]>;
}

/**
 * Splits the clips into groups worth one AI look each: waiting clips joined (directly or through each other) by a
 * pre-pass match. `alone` lists waiting clips nothing came close to (no AI call needed).
 */
export function similarityGroups(
  facts: ClipFacts[],
  limits = { waiting: 8, others: 6 },
): { groups: SimilarityGroup[]; alone: string[] } {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const candidates: Record<string, SimilarCandidate[]> = {};
  const waiting = facts.filter((f) => f.state === "waiting");
  const alone: string[] = [];
  for (const w of waiting) {
    const found = similarityCandidates(w, facts);
    if (!found.length) {
      alone.push(w.id);
      continue;
    }
    candidates[w.id] = found;
    for (const c of found) union(w.id, c.id);
  }
  const roots = new Map<string, string[]>();
  for (const id of Object.keys(candidates)) {
    const r = find(id);
    roots.set(r, [...(roots.get(r) ?? []), id]);
  }
  const groups: SimilarityGroup[] = [];
  for (const ids of roots.values()) {
    const sorted = ids
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .map((f) => f.id);
    // a very large cluster is split so each AI prompt stays small
    for (let i = 0; i < sorted.length; i += limits.waiting) {
      const w = sorted.slice(i, i + limits.waiting);
      const best = new Map<string, number>();
      for (const id of w)
        for (const c of candidates[id] ?? [])
          if (!w.includes(c.id) && byId.get(c.id)?.state !== "waiting")
            best.set(c.id, Math.max(best.get(c.id) ?? 0, c.score));
      const others = [...best.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limits.others)
        .map(([id]) => id);
      const members = [...w, ...others];
      groups.push({
        waiting: w,
        members,
        candidates: Object.fromEntries(
          w.map((id) => [
            id,
            (candidates[id] ?? []).filter((c) => members.includes(c.id)),
          ]),
        ),
      });
    }
  }
  groups.sort((a, b) => a.waiting[0]!.localeCompare(b.waiting[0]!));
  return { groups, alone };
}

// ---------- AI answers ----------

const RANK: Record<SimilarityLevel, number> = {
  distinct: 0,
  similar: 1,
  "near-duplicate": 2,
};

const clean = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * One AI's answer for a group: label ("C1") based verdicts turned into opinions per waiting clip (by queue group).
 * Unknown labels, self references and malformed rows are dropped; a missing verdict means no opinion for that clip.
 */
export function normalizeVerdicts(
  raw: unknown,
  labels: Record<string, string>,
  waiting: string[],
  by: SimilarityAgent,
): Record<string, SimilarityOpinion> {
  const rows = (raw as { verdicts?: unknown } | undefined)?.verdicts;
  const out: Record<string, SimilarityOpinion> = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Record<string, unknown>[]) {
    const id = labels[String(r?.clip ?? "").trim().toUpperCase()];
    if (!id || !waiting.includes(id) || out[id]) continue;
    const level = SIMILARITY_LEVELS.includes(r.level as SimilarityLevel)
      ? (r.level as SimilarityLevel)
      : undefined;
    const why = clean(r.why, 300);
    const recommendation = clean(r.recommendation, 300);
    if (!level || !why || !recommendation) continue;
    const similarTo =
      level === "distinct"
        ? []
        : [
            ...new Set(
              (Array.isArray(r.similarTo) ? r.similarTo : [])
                .map((x) => labels[String(x).trim().toUpperCase()])
                .filter((x): x is string => !!x && x !== id),
            ),
          ];
    out[id] = { by, level, similarTo, why, recommendation };
  }
  return out;
}

/** Two independent opinions into one line for the card: agree or differ, or the one that answered. */
export function mergeOpinions(
  opinions: SimilarityOpinion[],
  hadCandidates = true,
): SimilarityVerdict {
  if (!opinions.length)
    return hadCandidates
      ? { level: "unchecked", agreement: "none", similarTo: [] }
      : { level: "distinct", agreement: "none", similarTo: [] };
  // The more cautious opinion leads: its recommendation is the one to act on.
  const lead = [...opinions].sort(
    (a, b) =>
      RANK[b.level] - RANK[a.level] ||
      SIMILARITY_AGENTS.indexOf(a.by) - SIMILARITY_AGENTS.indexOf(b.by),
  )[0]!;
  const similarTo = [...new Set(opinions.flatMap((o) => o.similarTo))];
  return {
    level: lead.level,
    agreement:
      opinions.length < 2
        ? "single"
        : opinions.every((o) => o.level === lead.level)
          ? "agree"
          : "differ",
    similarTo,
    why: lead.why,
    recommendation: lead.recommendation,
  };
}

/** Whether the card should show the "Similar clips" box (rather than the one-line all-clear). */
export const looksSimilar = (s: ClipSimilarity | undefined) =>
  !!s &&
  (s.verdict.level === "similar" ||
    s.verdict.level === "near-duplicate" ||
    (s.verdict.level === "unchecked" && s.candidates.length > 0));

/**
 * Waiting clips that are near-duplicates of each other, as clusters of 2+ (for the hint above "Waiting for your
 * OK"). Only links between clips that are both waiting count.
 */
export function nearDuplicateClusters(
  waiting: { id: string; similarity?: ClipSimilarity }[],
): string[][] {
  const ids = new Set(waiting.map((w) => w.id));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const w of waiting) {
    const s = w.similarity;
    if (!s) continue;
    const dupes = new Set(
      s.opinions
        .filter((o) => o.level === "near-duplicate")
        .flatMap((o) => o.similarTo),
    );
    for (const other of dupes)
      if (ids.has(other)) {
        const a = find(w.id);
        const b = find(other);
        if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
      }
  }
  const out = new Map<string, string[]>();
  for (const w of waiting) {
    const r = find(w.id);
    out.set(r, [...(out.get(r) ?? []), w.id]);
  }
  return [...out.values()].filter((c) => c.length > 1);
}
