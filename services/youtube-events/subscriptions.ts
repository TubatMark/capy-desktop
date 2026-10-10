import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../../server/db";

export const channelPattern = /^UC[\w-]{22}$/;
export const videoPattern = /^[\w-]{11}$/;
export const topicFor = (channelId: string) =>
  `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
export const equalSecret = (a: string, b: string) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
async function withDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () =>
      reject(signal.reason ?? new Error("Subscription request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export interface ChannelSubscription {
  channelId: string;
  topic: string;
  callbackUrl: string;
  callbackToken: string;
  verifyToken: string;
  secret: string;
  verifyUntil?: number;
  activeUntil?: number;
  renewAt?: number;
  nextRenewAt?: number;
  failures: number;
  lastError?: string;
}
/** This repository is given the receiver's own Store; it never opens the desktop runtime store. */
export class Subscriptions {
  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}
  get(channelId: string) {
    return this.store.get<ChannelSubscription>(
      "websub-subscriptions",
      channelId,
    )?.value;
  }
  nextRenewalAt(channels?: ReadonlySet<string>): number | undefined {
    const times = this.store
      .list<ChannelSubscription>("websub-subscriptions")
      .filter((row) => !channels || channels.has(row.id))
      .map((row) => row.value.nextRenewAt ?? row.value.renewAt ?? 0);
    return times.length ? Math.min(...times) : undefined;
  }
  ensure(channelId: string, callbackBase: string): ChannelSubscription {
    if (!channelPattern.test(channelId))
      throw Error("Invalid YouTube channel ID");
    const base = new URL(callbackBase);
    if (
      base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      )
    )
      throw Error(
        "WebSub callback requires HTTPS (HTTP is allowed only for loopback fixtures)",
      );
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    )
      throw Error("Invalid callback base URL");
    return this.store.transaction(() => {
      const existing = this.get(channelId);
      if (existing) {
        if (new URL(existing.callbackUrl).origin !== base.origin)
          throw Error(
            "Subscription callback origin is pinned; create a separate receiver store to change it",
          );
        return existing;
      }
      const secret = () => randomBytes(32).toString("hex");
      const callbackToken = secret();
      const callback = new URL(`/callback/${channelId}`, base);
      callback.searchParams.set("token", callbackToken);
      const sub: ChannelSubscription = {
        channelId,
        topic: topicFor(channelId),
        callbackUrl: callback.toString(),
        callbackToken,
        verifyToken: secret(),
        secret: secret(),
        failures: 0,
      };
      this.store.save("websub-subscriptions", channelId, sub, 0);
      return sub;
    });
  }
  /** Keep the current lease until a requested renewal is verified by the hub. */
  async requestSubscribe(
    channelId: string,
    signal: AbortSignal,
    transport: typeof fetch = fetch,
    now = this.now(),
  ): Promise<void> {
    const sub = this.get(channelId);
    if (!sub) throw Error("Unknown subscription");
    this.store.mutate<ChannelSubscription>(
      "websub-subscriptions",
      channelId,
      () => sub,
      (value) => ({
        ...value,
        verifyUntil: now + 10 * 60_000,
        nextRenewAt: now + 10 * 60_000,
      }),
    );
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const response = await withDeadline(
        transport("https://pubsubhubbub.appspot.com/subscribe", {
          method: "POST",
          redirect: "error",
          signal: deadline,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            "hub.mode": "subscribe",
            "hub.topic": sub.topic,
            "hub.callback": sub.callbackUrl,
            "hub.verify": "async",
            "hub.verify_token": sub.verifyToken,
            "hub.lease_seconds": "864000",
            "hub.secret": sub.secret,
          }),
        }),
        deadline,
      );
      if (response.status !== 202 && !response.ok)
        throw Error(`Hub subscription request failed (${response.status})`);
      void response.body?.cancel().catch(() => {});
    } catch (error) {
      signal.throwIfAborted();
      this.store.mutate<ChannelSubscription>(
        "websub-subscriptions",
        channelId,
        () => sub,
        (value) => {
          const failures = value.failures + 1;
          return {
            ...value,
            failures,
            verifyUntil: undefined,
            lastError: error instanceof Error ? error.message : String(error),
            nextRenewAt:
              now +
              Math.min(3_600_000, 30_000 * 2 ** Math.min(failures - 1, 7)),
          };
        },
      );
    }
  }
  confirm(channelId: string, query: URLSearchParams): string | undefined {
    return this.store.transaction(() => {
      const sub = this.get(channelId);
      const now = this.now();
      const challenge = query.get("hub.challenge") ?? "";
      const lease = query.get("hub.lease_seconds") ?? "";
      const suppliedVerify = query.get("hub.verify_token");
      if (
        !sub ||
        !equalSecret(query.get("token") ?? "", sub.callbackToken) ||
        (suppliedVerify !== null &&
          !equalSecret(suppliedVerify, sub.verifyToken)) ||
        query.get("hub.topic") !== sub.topic ||
        query.get("hub.mode") !== "subscribe" ||
        !sub.verifyUntil ||
        sub.verifyUntil < now ||
        !/^[+\-./0-9=A-Z_a-z]{1,512}$/.test(challenge) ||
        !/^\d{1,8}$/.test(lease) ||
        Number(lease) < 1 ||
        Number(lease) > 31_536_000
      )
        return undefined;
      const duration = Number(lease) * 1000;
      this.store.mutate<ChannelSubscription>(
        "websub-subscriptions",
        channelId,
        () => sub,
        (value) => ({
          ...value,
          verifyUntil: undefined,
          activeUntil: now + duration,
          renewAt: now + Math.floor(duration * 0.8),
          nextRenewAt: undefined,
          failures: 0,
          lastError: undefined,
        }),
      );
      return challenge;
    });
  }
  async renewDue(
    signal: AbortSignal,
    transport: typeof fetch = fetch,
    now = this.now(),
    channels?: ReadonlySet<string>,
  ): Promise<void> {
    const due = this.store
      .list<ChannelSubscription>("websub-subscriptions")
      .map((r) => r.value)
      .filter(
        (s) =>
          (!channels || channels.has(s.channelId)) &&
          (s.nextRenewAt ?? s.renewAt ?? 0) <= now,
      );
    // Independent deadlines and failures: one creator cannot delay the other renewals indefinitely.
    let position = 0;
    const renew = async () => {
      while (position < due.length)
        await this.requestSubscribe(
          due[position++]!.channelId,
          signal,
          transport,
          now,
        );
    };
    await Promise.all(Array.from({ length: Math.min(3, due.length) }, renew));
  }
}
