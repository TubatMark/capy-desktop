import { z } from "zod";
import type {
  CreatorImport,
  ImportCreatorsResult,
  SubscriptionPage,
  WatchedChannel,
} from "../lib/types";
import type { Upload } from "../src/youtube";
import {
  AuthError,
  getReadingAccessToken,
  loadAccounts,
  loadReadingAccount,
  saveReadingAccount,
} from "./accounts";
import { runtimeStore } from "./db/runtime";
import { addChannel, watch } from "./watch";

export class SubscriptionAccessError extends Error {
  readonly reconnect = true;
}
const Import = z.strictObject({
  accountId: z.string().min(1).max(128),
  selectedIds: z
    .array(z.string().regex(/^UC[\w-]{22}$/))
    .min(1)
    .max(5000),
  backfill: z.boolean(),
  mode: z.enum(["manual", "automatic_drafts"]),
});

async function readingToken(accountId: string, f: typeof fetch) {
  try {
    return await getReadingAccessToken(accountId, f);
  } catch (e) {
    if (e instanceof AuthError) throw new SubscriptionAccessError(e.message);
    throw e;
  }
}
interface YoutubeResponse {
  nextPageToken?: string;
  items?: {
    id?: string;
    snippet?: {
      title?: string;
      resourceId?: { channelId?: string; videoId?: string };
      thumbnails?: Record<string, { url?: string }>;
    };
    contentDetails?: {
      relatedPlaylists?: { uploads?: string };
      duration?: string;
    };
  }[];
  error?: { message?: string; errors?: { reason?: string }[] };
}
async function readYoutube(
  accountId: string,
  resource: string,
  params: Record<string, string>,
  f: typeof fetch,
): Promise<YoutubeResponse> {
  const token = await readingToken(accountId, f);
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  url.search = new URLSearchParams(params).toString();
  const res = await f(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = (await res.json()) as YoutubeResponse;
  if (!res.ok || body.error) {
    const auth =
      res.status === 401 ||
      body.error?.errors?.some((e) =>
        [
          "insufficientPermissions",
          "authError",
          "subscriptionForbidden",
          "accountClosed",
          "accountSuspended",
        ].includes(e.reason ?? ""),
      );
    if (auth) {
      if (loadReadingAccount().tokens?.accessToken === token)
        saveReadingAccount({ needsReconnect: true });
      throw new SubscriptionAccessError(
        "Reconnect the YouTube reading account to restore subscription access",
      );
    }
    throw new Error(
      body.error?.message ??
        `YouTube could not load ${resource} (${res.status})`,
    );
  }
  if (loadReadingAccount().account?.id !== accountId)
    throw new SubscriptionAccessError(
      "The reading account changed; refresh subscriptions",
    );
  return body;
}
/** Only the read-only subscriptions.list operation; never inserts or deletes YouTube subscriptions. */
export async function listSubscriptions(
  accountId: string,
  cursor?: string,
  f: typeof fetch = fetch,
): Promise<SubscriptionPage> {
  const body = await readYoutube(
    accountId,
    "subscriptions",
    {
      part: "snippet",
      mine: "true",
      maxResults: "50",
      ...(cursor ? { pageToken: cursor } : {}),
    },
    f,
  );
  const channels = new Map<string, SubscriptionPage["channels"][number]>();
  for (const item of body.items ?? []) {
    const id = item.snippet?.resourceId?.channelId;
    if (!id || !/^UC[\w-]{22}$/.test(id)) continue;
    channels.set(id, {
      id,
      name: item.snippet?.title ?? id,
      thumbnail:
        item.snippet?.thumbnails?.medium?.url ??
        item.snippet?.thumbnails?.default?.url,
    });
  }
  return {
    accountId,
    channels: [...channels.values()],
    nextCursor: body.nextPageToken,
  };
}
const seconds = (duration = "") => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration);
  return m
    ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
    : undefined;
};
/** Baseline recent uploads before enabling a creator so an import does not become an implicit backfill. */
async function recentUploads(
  accountId: string,
  channelId: string,
  f: typeof fetch,
): Promise<Upload[]> {
  const channel = await readYoutube(
    accountId,
    "channels",
    { part: "contentDetails", id: channelId },
    f,
  );
  const playlistId =
    channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId)
    throw new Error(
      `Could not establish existing uploads for ${channelId}; try importing again`,
    );
  const playlist = await readYoutube(
    accountId,
    "playlistItems",
    { part: "snippet", playlistId, maxResults: "50" },
    f,
  );
  const items = (playlist.items ?? []).filter(
    (i) => i.snippet?.resourceId?.videoId,
  );
  if (!items.length) return [];
  const details = await readYoutube(
    accountId,
    "videos",
    {
      part: "contentDetails",
      id: items.map((i) => i.snippet!.resourceId!.videoId!).join(","),
    },
    f,
  );
  const durations = new Map(
    (details.items ?? []).map((i) => [
      i.id,
      seconds(i.contentDetails?.duration),
    ]),
  );
  return items.map((i) => ({
    id: i.snippet!.resourceId!.videoId!,
    title: i.snippet?.title ?? "YouTube upload",
    live: durations.get(i.snippet!.resourceId!.videoId!) === undefined,
    duration: durations.get(i.snippet!.resourceId!.videoId!),
  }));
}
export interface SubscriptionDeps {
  fetch?: typeof fetch;
  uploads?: (channelId: string) => Promise<Upload[]>;
  now?: () => Date;
}
/** Reconcile selected creators atomically, preserving every existing creator's preferences and history. */
export async function importCreators(
  input: CreatorImport,
  deps: SubscriptionDeps = {},
): Promise<ImportCreatorsResult> {
  const parsed = Import.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `Invalid import ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`,
    );
  const data = parsed.data;
  const f = deps.fetch ?? fetch;
  await readingToken(data.accountId, f);
  const store = runtimeStore();
  const roleRevision = store.get("account-roles", "youtube:reading")?.revision;
  const available = new Map<string, SubscriptionPage["channels"][number]>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listSubscriptions(data.accountId, cursor, f);
    for (const c of page.channels) available.set(c.id, c);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor))
      throw new Error(
        "YouTube repeated a subscription page; refresh and try again",
      );
    if (cursor) cursors.add(cursor);
    if (cursors.size > 1000)
      throw new Error("Subscription list exceeds the safe import limit");
  } while (cursor);
  const ids = [...new Set(data.selectedIds)];
  if (ids.some((id) => !available.has(id)))
    throw new Error(
      "Some selected channels are no longer subscriptions; refresh the list",
    );
  const destinationId = loadAccounts().youtube.account?.id;
  if (destinationId && ids.includes(destinationId))
    throw new Error(
      "A YouTube publishing destination cannot watch itself; deselect that channel",
    );
  const known = new Set(
    watch()
      .get()
      .channels.map((c) => c.id),
  );
  const prepared: WatchedChannel[] = [];
  for (const id of ids) {
    if (known.has(id)) continue;
    const c = available.get(id)!;
    const uploads = await (deps.uploads
      ? deps.uploads(id)
      : recentUploads(data.accountId, id, f));
    const initial = addChannel(
      { channels: [], maxPerDay: 6, intervalMin: 60 },
      { id, name: c.name, url: `https://www.youtube.com/channel/${id}/videos` },
      uploads,
      { now: deps.now?.() ?? new Date(), clipLatest: data.backfill },
    ).channels[0]!;
    prepared.push({
      ...initial,
      enabled: data.mode === "automatic_drafts",
      mode: data.mode,
      thumbnail: c.thumbnail,
      sourceAccountId: data.accountId,
    });
  }
  return store.transaction(() => {
    if (
      loadReadingAccount().account?.id !== data.accountId ||
      loadReadingAccount().needsReconnect ||
      store.get("account-roles", "youtube:reading")?.revision !== roleRevision
    )
      throw new SubscriptionAccessError(
        "The reading account changed; refresh subscriptions before importing",
      );
    const imported: WatchedChannel[] = [];
    const existing: string[] = [];
    watch().mutate((current) => {
      const channels = [...current.channels];
      for (const id of ids) {
        if (channels.some((c) => c.id === id)) {
          existing.push(id);
          continue;
        }
        const c = prepared.find((c) => c.id === id);
        if (!c)
          throw new Error(
            "A creator changed during import; refresh subscriptions and try again",
          );
        channels.push(c);
        imported.push(c);
        store.save(
          "creator-imports",
          id,
          {
            channelId: id,
            sourceAccountId: data.accountId,
            mode: data.mode,
            backfill: data.backfill,
            importedAt: c.addedAt,
          },
          store.get("creator-imports", id)?.revision ?? 0,
        );
      }
      return { ...current, channels };
    });
    return { imported, existing };
  });
}
