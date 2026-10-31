import { DEFAULT_TUNING, judge, type DailyReport, type PostedRow, type Tuning } from "../lib/daily-check";
import type { ShortTestResult } from "../lib/shorts-test";
import { getAccessToken, loadAccounts } from "./accounts";
import { runtimeStore } from "./db/runtime";
import { refreshPublicationMetrics } from "./performance";
import { SHORT_TEST_RESULTS } from "./shorts-test";

const CONFIG = "longform-config";
const MANILA_MS = 8 * 3600_000;
/** Refreshing goes a batch at a time; this covers a long list without running away. */
const MAX_REFRESH_BATCHES = 8;

export const loadTuning = (): Tuning => ({ ...DEFAULT_TUNING, ...runtimeStore().get<Partial<Tuning>>(CONFIG, "tuning")?.value });
export const loadDailyReport = () => runtimeStore().get<DailyReport>(CONFIG, "daily-report")?.value;
const dayOf = (at: number) => Math.floor((at + MANILA_MS) / 86400_000);

interface QueueRow {
  jobId?: string;
  n?: number;
  status: string;
  clipTitle: string;
  slotAt?: number;
  updatedAt?: number;
  result?: { id?: string };
}
interface RawJob {
  channel?: string;
  clips?: { n: number; shortTest?: { group: string } }[];
}

async function report(f: typeof fetch, token: string, p: Record<string, string>) {
  const q = new URLSearchParams({ ids: "channel==MINE", startDate: "2026-01-01", endDate: new Date().toISOString().slice(0, 10), ...p });
  const r = await f(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw Error(`Analytics refused the request (HTTP ${r.status})`);
  return ((await r.json()) as { rows?: (string | number)[][] }).rows ?? [];
}

/** Numbers for every Short capy posted. A clip with no test group counts as plain: it had nothing added. */
async function readRows(f: typeof fetch): Promise<PostedRow[]> {
  const store = runtimeStore();
  const account = loadAccounts().youtube.account?.id;
  const token = await getAccessToken("youtube", f, account);
  const posted = (store.get<QueueRow[]>("legacy-state", "queue")?.value ?? []).filter((e) => e.status === "posted" && e.result?.id);
  const rows: PostedRow[] = [];
  for (const e of posted) {
    const filters = `video==${e.result!.id}`;
    const sources = await report(f, token, { metrics: "views", dimensions: "insightTrafficSourceType", filters }).catch(() => []);
    const totals = (await report(f, token, { metrics: "views,engagedViews,averageViewPercentage", filters }).catch(() => []))[0];
    const job = e.jobId ? store.get<RawJob>("legacy-jobs", e.jobId)?.value : undefined;
    const group = job?.clips?.find((c) => c.n === e.n)?.shortTest?.group;
    const views = Number(totals?.[0] ?? 0);
    rows.push({
      videoId: e.result!.id!,
      title: e.clipTitle,
      group: group === "narrated" ? "narrated" : "plain",
      postedAt: e.slotAt ?? e.updatedAt ?? 0,
      views,
      feedViews: Number(sources.find((x) => x[0] === "SHORTS")?.[1] ?? 0),
      stayed: views > 0 ? Number(totals?.[1] ?? 0) / views : undefined,
      avgViewPct: totals ? Number(totals[2]) : undefined,
      creator: job?.channel,
    });
  }
  return rows;
}

/** Fresh numbers for the page, the judgment, and any change that follows from it. */
export async function runDailyCheck(now = Date.now(), f: typeof fetch = fetch): Promise<DailyReport | undefined> {
  const a = loadAccounts().youtube;
  const id = a.account?.id;
  if (!id || !a.tokens?.accessToken || a.needsReconnect) return undefined;
  for (let i = 0; i < MAX_REFRESH_BATCHES; i++) {
    const r = await refreshPublicationMetrics(id);
    if (!r.continuation) break;
  }
  const rows = await readRows(f);
  const { report: result, tuning } = judge(rows, loadTuning(), now);
  const store = runtimeStore();
  store.transaction(() => {
    store.put(CONFIG, "daily-report", result);
    store.put(CONFIG, "tuning", tuning);
    store.put(CONFIG, SHORT_TEST_RESULTS, rows.map((r): ShortTestResult => ({ videoId: r.videoId, group: r.group, postedAt: r.postedAt, views: r.views, feedViews: r.feedViews, stayed: r.stayed })));
  });
  return result;
}

/** Called from the worker's regular check: runs once per Philippine day. */
export async function maybeRunDailyCheck(now = Date.now()) {
  const last = loadDailyReport()?.at;
  if (last !== undefined && dayOf(last) === dayOf(now)) return undefined;
  return runDailyCheck(now);
}
