import { z } from "zod";
import { loadAccounts } from "../accounts";
import { runtimeStore } from "../db/runtime";
import { fence } from "../worker/context";
import { watch } from "../watch";
import { abortable, readResponseBody } from "./readiness";
import type { DiscoveryRecord } from "./reconcile";

const Event = z.strictObject({
  id: z.string().min(1).max(200),
  receiverId: z.uuid(),
  sequence: z.number().int().positive(),
  channelId: z.string().regex(/^UC[\w-]{22}$/),
  videoId: z.string().regex(/^[\w-]{11}$/),
  topic: z.string().max(200),
  updatedAt: z.number().finite().nonnegative(),
  receivedAt: z.number().finite().nonnegative(),
});
export type ValidatedChannelEvent = z.infer<typeof Event>;
export interface EventReceipt {
  status: "accepted" | "duplicate" | "rejected" | "ignored";
  reason?: string;
}
interface EventHint {
  dirty: boolean;
  eventId: string;
}
/** Events are hints, never upload/readiness evidence. Source claims and import cutoffs remain authoritative. */
export async function ingestChannelEvent(
  event: ValidatedChannelEvent,
): Promise<EventReceipt> {
  return fence(() => runtimeStore().transaction(() => ingest(event)));
}
function ingest(input: unknown): EventReceipt {
  const parsed = Event.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.topic !==
      `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${parsed.data.channelId}`
  )
    return { status: "rejected", reason: "Invalid channel event or topic" };
  const event = parsed.data;
  const ch = watch()
    .get()
    .channels.find((c) => c.id === event.channelId);
  if (!ch?.enabled || loadAccounts().youtube.account?.id === event.channelId)
    return {
      status: "ignored",
      reason: "Channel is disabled, unwatched, or a publishing destination",
    };
  const store = runtimeStore();
  if (!store.claim("discovery-event", event.id, event.id))
    return { status: "duplicate" };
  store.save("discovery-events", event.id, event, 0);
  if (
    store.get<DiscoveryRecord>(
      "discovery-videos",
      `${event.channelId}:${event.videoId}`,
    )?.value.accepted
  )
    return {
      status: "ignored",
      reason:
        "Source video already has a durable discovery claim; metadata edits do not reclip it",
    };
  store.mutate<EventHint>(
    "discovery-event-hints",
    event.channelId,
    () => ({ dirty: true, eventId: event.id }),
    () => ({ dirty: true, eventId: event.id }),
  );
  return { status: "accepted" };
}
export const pendingChannelEvents = () =>
  new Map(
    runtimeStore()
      .list<EventHint>("discovery-event-hints")
      .filter((r) => r.value.dirty)
      .map((r) => [r.id, r.revision]),
  );
export function acknowledgeChannelEvents(channelId: string, revision: number) {
  fence(() =>
    runtimeStore().transaction(() => {
      const current = runtimeStore().get<EventHint>(
        "discovery-event-hints",
        channelId,
      );
      if (current?.revision === revision)
        runtimeStore().save(
          "discovery-event-hints",
          channelId,
          { ...current.value, dirty: false },
          revision,
        );
    }),
  );
}
export interface EventPullDeps {
  endpoint?: string;
  token?: string;
  fetch?: typeof fetch;
}
/** Called only from worker watcher execution; polling remains usable with no receiver configuration. */
export async function pullChannelEvents(
  signal: AbortSignal,
  deps: EventPullDeps = {},
): Promise<number> {
  const endpoint = deps.endpoint ?? process.env.CAPY_YOUTUBE_EVENTS_URL;
  const token = deps.token ?? process.env.CAPY_YOUTUBE_EVENTS_TOKEN;
  if (!endpoint) return 0;
  if (!token)
    throw Error("Configure a separate YouTube event receiver retrieval token");
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw Error("Event receiver retrieval requires HTTPS");
  if (url.username || url.password || url.search || url.hash)
    throw Error("Invalid event receiver URL");
  const store = runtimeStore();
  const state = store.get<{ cursor: number; receiverId: string }>(
    "discovery-receiver",
    endpoint,
  );
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const fetchPage = async (cursor: number) => {
    url.searchParams.set("after", String(cursor));
    const response = await abortable(
      (deps.fetch ?? fetch)(url, {
        signal: bounded,
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        redirect: "error",
      }),
      bounded,
    );
    if (!response.ok)
      throw Error(
        `Event receiver retrieval failed (${response.status}); ordinary polling remains enabled`,
      );
    const raw = JSON.parse(
      await readResponseBody(response, bounded, 128 * 1024),
    );
    const page = z
      .strictObject({
        receiverId: z.uuid(),
        events: z.array(Event).max(100),
        nextCursor: z.number().int().nonnegative(),
      })
      .parse(raw);
    let previous = cursor;
    for (const event of page.events) {
      if (
        event.receiverId !== page.receiverId ||
        event.sequence <= previous ||
        event.topic !==
          `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${event.channelId}`
      )
        throw Error("Invalid receiver event sequence or topic");
      previous = event.sequence;
    }
    if (page.nextCursor !== previous)
      throw Error("Event receiver cursor does not match its complete page");
    return page;
  };
  let page = await fetchPage(state?.value.cursor ?? 0);
  // A replacement receiver store has a new identity. Reconcile its complete sequence from zero.
  if (state && state.value.receiverId !== page.receiverId)
    page = await fetchPage(0);
  bounded.throwIfAborted();
  return fence(() =>
    store.transaction(() => {
      bounded.throwIfAborted();
      let accepted = 0;
      for (const event of page.events)
        if (ingest(event).status === "accepted") accepted++;
      store.save(
        "discovery-receiver",
        endpoint,
        { cursor: page.nextCursor, receiverId: page.receiverId },
        state?.revision ?? 0,
      );
      return accepted;
    }),
  );
}
