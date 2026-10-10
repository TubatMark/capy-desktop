import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  createEventService,
  createEventServer,
} from "../services/youtube-events/handler";
import {
  ingestChannelEvent,
  pullChannelEvents,
} from "../server/discovery/events";
import { reconcileCreator } from "../server/discovery/reconcile";
import { saveReadingAccount, resetAccountsCache } from "../server/accounts";
import { addChannel, mapChannel, watch } from "../server/watch";
import { watcherTick } from "../server/watcher";
import { runtimeStore } from "../server/db/runtime";
const root = mkdtempSync(path.join(os.tmpdir(), "capy-websub-"));
let serial = 0;
const channelId = `UC${"3".repeat(22)}`;
const videoId = "video123456";
const token = "fixture-retrieval-token-123456789";
const now = 1_800_000_000_000;
const services: ReturnType<typeof createEventService>[] = [];
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, `desktop-${++serial}`);
  resetAccountsCache();
});
afterAll(() => {
  for (const s of services) s.close();
  rmSync(root, { recursive: true, force: true });
});
function service() {
  const s = createEventService({
    storeFile: path.join(root, `receiver-${serial}.sqlite`),
    retrievalToken: token,
    now: () => now,
  });
  services.push(s);
  return s;
}
const xml = (updated = new Date(now + 1).toISOString(), id = channelId) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><link rel="self" href="https://www.youtube.com/xml/feeds/videos.xml?channel_id=${id}"/><entry><id>yt:video:${videoId}</id><yt:videoId>${videoId}</yt:videoId><yt:channelId>${id}</yt:channelId><updated>${updated}</updated><title>Edited title</title></entry></feed>`;
async function activate(
  s: ReturnType<typeof service>,
  callbackBase = "http://127.0.0.1:5555",
) {
  const sub = s.subscriptions.ensure(channelId, callbackBase);
  await s.subscriptions.requestSubscribe(
    channelId,
    new AbortController().signal,
    (async () => new Response(null, { status: 202 })) as typeof fetch,
  );
  const u = new URL(sub.callbackUrl);
  u.searchParams.set("hub.mode", "subscribe");
  u.searchParams.set("hub.topic", sub.topic);
  u.searchParams.set("hub.challenge", "challenge-123");
  u.searchParams.set("hub.lease_seconds", "3600");
  u.searchParams.set("hub.verify_token", sub.verifyToken);
  expect((await s.handle(new Request(u))).status).toBe(200);
  return sub;
}
function signed(sub: Awaited<ReturnType<typeof activate>>, body: string) {
  return new Request(sub.callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/atom+xml",
      "x-hub-signature": `sha256=${createHmac("sha256", sub.secret).update(body).digest("hex")}`,
    },
    body,
  });
}
it("validates expected topics/tokens, lease windows, signatures and bounded XML", async () => {
  const s = service();
  const sub = await activate(s);
  for (const change of [
    "hub.topic=wrong",
    "hub.verify_token=wrong",
    "hub.lease_seconds=0",
  ]) {
    await s.subscriptions.requestSubscribe(
      channelId,
      new AbortController().signal,
      (async () => new Response(null, { status: 202 })) as typeof fetch,
    );
    const u = new URL(sub.callbackUrl);
    u.searchParams.set("hub.mode", "subscribe");
    u.searchParams.set("hub.topic", sub.topic);
    u.searchParams.set("hub.challenge", "safe");
    u.searchParams.set("hub.lease_seconds", "3600");
    const [key, value] = change.split("=");
    u.searchParams.set(key!, value!);
    expect((await s.handle(new Request(u))).status).toBe(403);
  }
  expect(
    (
      await s.handle(
        new Request(sub.callbackUrl, { method: "POST", body: xml() }),
      )
    ).status,
  ).toBe(403);
  for (const body of [
    "<feed><entry></feed>",
    `<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>${xml()}`,
    xml(undefined, `UC${"4".repeat(22)}`),
  ])
    expect((await s.handle(signed(sub, body))).status).toBe(400);
  expect((await s.handle(signed(sub, "x".repeat(65_537)))).status).toBe(413);
  expect((await s.handle(new Request("http://localhost/events"))).status).toBe(
    401,
  );
});
it("event_edits_do_not_reclip: upload, duplicate, metadata change and restart produce one source job", async () => {
  const s = service();
  const sub = await activate(s);
  expect((await s.handle(signed(sub, xml()))).status).toBe(202);
  expect((await s.handle(signed(sub, xml()))).status).toBe(202);
  const edited = await s.handle(
    signed(sub, xml(new Date(now + 2).toISOString())),
  );
  expect(edited.status).toBe(202);
  const res = await s.handle(
    new Request("http://localhost/events", {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  const body = await res.json();
  expect(body.events).toHaveLength(2);
  expect(JSON.stringify(body)).not.toMatch(
    /secret|verifyToken|callbackToken|retrieval/,
  );
  saveReadingAccount({
    account: { id: "reader", name: "Reader" },
    tokens: {
      accessToken: "read",
      expiresAt: Date.now() + 3_600_000,
      scope: "https://www.googleapis.com/auth/youtube.readonly",
    },
  });
  watch().mutate((f) =>
    mapChannel(
      addChannel(
        f,
        {
          id: channelId,
          name: "Creator",
          url: `https://www.youtube.com/channel/${channelId}/videos`,
        },
        [],
        { now: new Date(now) },
      ),
      channelId,
      (c) => ({ ...c, sourceAccountId: "reader", discoveryAfter: now }),
    ),
  );
  const api = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const name = u.pathname.split("/").pop();
    if (name === "channels")
      return Response.json({
        items: [
          { contentDetails: { relatedPlaylists: { uploads: "uploads" } } },
        ],
      });
    if (name === "playlistItems")
      return Response.json({ items: [{ contentDetails: { videoId } }] });
    return Response.json({
      items: [
        {
          id: videoId,
          snippet: {
            title: "Metadata edited",
            channelId,
            publishedAt: new Date(now + 1).toISOString(),
            liveBroadcastContent: "none",
          },
          contentDetails: { duration: "PT10M" },
          status: { privacyStatus: "public", uploadStatus: "processed" },
        },
      ],
    });
  }) as typeof fetch;
  const jobs: string[] = [];
  for (const event of [...body.events, body.events[0]]) {
    await ingestChannelEvent(event);
    await watcherTick(
      {
        now: () => new Date(now + 1000),
        lock: () => "held",
        list: async () => [],
        reconcile: (id, signal) =>
          reconcileCreator(id, signal, { fetch: api, force: true }),
        createJob: async (id) => {
          jobs.push(id);
        },
      },
      { force: true },
    );
    // Forget bounded processing history and seen IDs: metadata edits must still use the durable source identity.
    watch().mutate((f) =>
      mapChannel(f, channelId, (c) => ({
        ...c,
        seen: [],
        pending: [],
        history: [],
      })),
    );
  }
  expect(jobs).toEqual([videoId]);
  expect(await ingestChannelEvent(body.events[0])).toMatchObject({
    status: "duplicate",
  });
  expect(
    await ingestChannelEvent({ ...body.events[0], topic: "wrong" }),
  ).toMatchObject({ status: "rejected" });
  const reopened = createEventService({
    storeFile: path.join(root, `receiver-${serial}.sqlite`),
    retrievalToken: token,
    now: () => now,
  });
  services.push(reopened);
  expect(
    (
      await (
        await reopened.handle(
          new Request("http://localhost/events", {
            headers: { Authorization: `Bearer ${token}` },
          }),
        )
      ).json()
    ).events,
  ).toHaveLength(2);
});
it("renews before expiry, keeps the old lease on failed renewal, and backs off", async () => {
  const s = service();
  const sub = await activate(s);
  const lease = s.subscriptions.get(channelId)!.activeUntil;
  const fetcher = vi.fn(
    async () => new Response(null, { status: 503 }),
  ) as unknown as typeof fetch;
  await s.subscriptions.renewDue(
    new AbortController().signal,
    fetcher,
    now + 3_000_000,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(s.subscriptions.get(channelId)!.activeUntil).toBe(lease);
  await s.subscriptions.renewDue(
    new AbortController().signal,
    fetcher,
    now + 3_000_001,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(s.subscriptions.get(channelId)!.topic).toBe(sub.topic);
});
it("actual local callback replay and authenticated worker retrieval integration", async () => {
  const s = service();
  const server = createEventServer(s);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No listener");
    const base = `http://127.0.0.1:${address.port}`;
    const sub = await activate(s, base);
    const challenge = new URL(sub.callbackUrl);
    challenge.searchParams.set("hub.mode", "subscribe");
    challenge.searchParams.set("hub.topic", sub.topic);
    challenge.searchParams.set("hub.challenge", "real-challenge");
    challenge.searchParams.set("hub.lease_seconds", "3600");
    await s.subscriptions.requestSubscribe(
      channelId,
      new AbortController().signal,
      (async () => new Response(null, { status: 202 })) as typeof fetch,
    );
    const challengeResponse = await fetch(challenge);
    expect(await challengeResponse.text()).toBe("real-challenge");
    expect(challengeResponse.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect((await fetch(signed(sub, xml()))).status).toBe(202);
    expect((await fetch(signed(sub, xml()))).status).toBe(202);
    expect((await fetch(`${base}/events`)).status).toBe(401);
    watch().mutate((f) =>
      addChannel(
        f,
        { id: channelId, name: "Creator", url: `${base}/channel` },
        [],
        { now: new Date(now) },
      ),
    );
    const config = { endpoint: `${base}/events`, token };
    expect(await pullChannelEvents(new AbortController().signal, config)).toBe(
      1,
    );
    expect(await pullChannelEvents(new AbortController().signal, config)).toBe(
      0,
    );
    watch().mutate((f) => ({ ...f, lastCheckAt: now }));
    const reconciled: string[] = [];
    const workerDeps = {
      now: () => new Date(now + 1000),
      lock: () => "held" as const,
      list: async () => [],
      pullEvents: (signal: AbortSignal) => pullChannelEvents(signal, config),
      reconcile: async (id: string) => {
        reconciled.push(id);
        return { channelId: id, complete: true, discovered: 0 };
      },
      createJob: async () => {},
    };
    await watcherTick(workerDeps);
    await watcherTick(workerDeps);
    expect(reconciled).toEqual([channelId]);
    expect(watch().get().lastCheckAt).toBe(now);
    const retrieval = await (
      await fetch(`${base}/events`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    expect(retrieval.events).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
it("authenticated retrieval paginates 105 durable events and rejects malformed pages without advancing", async () => {
  const s = service();
  const sub = await activate(s);
  const batch = (start: number, count: number) =>
    xml().replace(
      /<entry>[\s\S]*<\/entry>/,
      Array.from({ length: count }, (_, n) =>
        xml()
          .match(/<entry>[\s\S]*<\/entry>/)![0]
          .replaceAll(videoId, `v${String(start + n).padStart(10, "0")}`),
      ).join(""),
    );
  expect((await s.handle(signed(sub, batch(0, 60)))).status).toBe(202);
  expect((await s.handle(signed(sub, batch(60, 45)))).status).toBe(202);
  watch().mutate((f) =>
    addChannel(
      f,
      {
        id: channelId,
        name: "Creator",
        url: "https://youtube.com/channel/creator/videos",
      },
      [],
      { now: new Date(now) },
    ),
  );
  let current = s;
  const transport: typeof fetch = async (input, init) =>
    current.handle(new Request(input, init));
  const config = {
    endpoint: "http://127.0.0.1/events",
    token,
    fetch: transport,
  };
  const malformed: typeof fetch = async (input, init) => {
    const body = await (await transport(input, init)).json();
    body.events[1].topic = "wrong";
    return Response.json(body);
  };
  await expect(
    pullChannelEvents(new AbortController().signal, {
      ...config,
      fetch: malformed,
    }),
  ).rejects.toThrow(/topic/);
  expect(
    runtimeStore().get("discovery-receiver", config.endpoint),
  ).toBeUndefined();
  expect(runtimeStore().list("discovery-events")).toEqual([]);
  expect(await pullChannelEvents(new AbortController().signal, config)).toBe(
    100,
  );
  expect(await pullChannelEvents(new AbortController().signal, config)).toBe(5);
  expect(await pullChannelEvents(new AbortController().signal, config)).toBe(0);
  expect(runtimeStore().list("discovery-events")).toHaveLength(105);
  current = createEventService({
    storeFile: path.join(root, `replacement-${serial}.sqlite`),
    retrievalToken: token,
    now: () => now,
  });
  services.push(current);
  const replacement = await activate(current);
  await current.handle(signed(replacement, xml()));
  expect(await pullChannelEvents(new AbortController().signal, config)).toBe(1);
  expect(
    runtimeStore().get<{ cursor: number }>(
      "discovery-receiver",
      config.endpoint,
    )?.value.cursor,
  ).toBe(1);
});
it("expired leases reject callbacks and failed retrieval leaves ordinary polling usable", async () => {
  let time = now;
  const s = createEventService({
    storeFile: path.join(root, `expiry-${serial}.sqlite`),
    retrievalToken: token,
    now: () => time,
  });
  services.push(s);
  const sub = await activate(s);
  time += 3_600_001;
  expect((await s.handle(signed(sub, xml()))).status).toBe(403);
  const wrong = new URL(sub.callbackUrl);
  wrong.searchParams.set("token", "wrong");
  expect((await s.handle(new Request(wrong))).status).toBe(403);
  watch().mutate((f) =>
    addChannel(
      f,
      { id: channelId, name: "Creator", url: sub.callbackUrl },
      [],
      { now: new Date(now) },
    ),
  );
  const reconcile = vi.fn(async (id: string) => ({
    channelId: id,
    complete: true,
    discovered: 0,
  }));
  await watcherTick({
    now: () => new Date(now),
    lock: () => "held",
    list: async () => [],
    pullEvents: async () => {
      throw Error("Receiver is offline");
    },
    reconcile,
    createJob: async () => {},
  });
  expect(reconcile).toHaveBeenCalledOnce();
  expect(
    runtimeStore().get<{ error: string }>(
      "discovery-receiver-health",
      "service",
    )?.value.error,
  ).toContain("offline");
});
