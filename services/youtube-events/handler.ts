import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { DOMParser } from "@xmldom/xmldom";
import { Store } from "../../server/db";
import {
  Subscriptions,
  channelPattern,
  videoPattern,
  equalSecret,
  type ChannelSubscription,
} from "./subscriptions";

const MAX_BODY = 65_536;
const ATOM = "http://www.w3.org/2005/Atom";
const YOUTUBE = "http://www.youtube.com/xml/schemas/2015";
interface ReceiverEvent {
  id: string;
  receiverId: string;
  sequence: number;
  channelId: string;
  videoId: string;
  topic: string;
  updatedAt: number;
  receivedAt: number;
}
class PayloadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function boundedBody(request: Request): Promise<Buffer> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
    throw new PayloadError(413, "Payload exceeds limit");
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const timeout = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(10_000),
  ]);
  const abort = () => {
    void reader.cancel();
  };
  timeout.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      timeout.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_BODY)
        throw new PayloadError(413, "Payload exceeds limit");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    return Buffer.concat(chunks, length);
  } finally {
    timeout.removeEventListener("abort", abort);
    await reader.cancel();
  }
}
function parseEvents(
  body: Buffer,
  subscription: ChannelSubscription,
): { videoId: string; updatedAt: number }[] {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new PayloadError(400, "Malformed UTF-8 payload");
  }
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml))
    throw new PayloadError(400, "XML declarations are not accepted");
  const fail = () => {
    throw new PayloadError(400, "Malformed Atom payload");
  };
  const document = new DOMParser({
    errorHandler: { warning: fail, error: fail, fatalError: fail },
  }).parseFromString(xml, "application/xml");
  const feed = document.documentElement;
  if (!feed || feed.localName !== "feed" || feed.namespaceURI !== ATOM) fail();
  const links = Array.from(feed.getElementsByTagNameNS(ATOM, "link"));
  if (
    !links.some(
      (link) =>
        link.parentNode === feed &&
        link.getAttribute("rel") === "self" &&
        link.getAttribute("href") === subscription.topic,
    )
  )
    fail();
  const entries = Array.from(feed.getElementsByTagNameNS(ATOM, "entry"));
  if (entries.length > 100)
    throw new PayloadError(413, "Too many Atom entries");
  return entries.map((entry) => {
    if (entry.parentNode !== feed) fail();
    const text = (namespace: string, tag: string) => {
      const nodes = Array.from(
        entry.getElementsByTagNameNS(namespace, tag),
      ).filter((n) => n.parentNode === entry);
      if (
        nodes.length !== 1 ||
        nodes[0]!.childNodes.length !== 1 ||
        nodes[0]!.firstChild?.nodeType !== 3
      )
        fail();
      return nodes[0]!.textContent?.trim() ?? "";
    };
    const channelId = text(YOUTUBE, "channelId"),
      videoId = text(YOUTUBE, "videoId");
    const updatedAt = Date.parse(text(ATOM, "updated"));
    if (
      channelId !== subscription.channelId ||
      !channelPattern.test(channelId) ||
      !videoPattern.test(videoId) ||
      !Number.isFinite(updatedAt) ||
      text(ATOM, "id") !== `yt:video:${videoId}`
    )
      fail();
    return { videoId, updatedAt };
  });
}
export interface EventServiceOptions {
  storeFile: string;
  retrievalToken: string;
  now?: () => number;
}
/** Standalone receiver: no Next routes, OAuth tokens, desktop runtime store, or media operations. */
export function createEventService(options: EventServiceOptions) {
  if (options.retrievalToken.length < 24)
    throw Error(
      "Use a separate random receiver retrieval token of at least 24 characters",
    );
  if (
    !path.isAbsolute(options.storeFile) ||
    path.basename(options.storeFile) === "capy.sqlite"
  )
    throw Error("Use an absolute, separate receiver database path");
  const directory = path.dirname(options.storeFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (statSync(directory).mode & 0o077)
    throw Error("Use a private receiver storage directory (mode 0700)");
  const store = new Store(options.storeFile);
  chmodSync(options.storeFile, 0o600);
  const now = options.now ?? Date.now;
  const receiverId = store.mutate<{ id: string }>(
    "websub",
    "identity",
    () => ({ id: randomUUID() }),
    (value) => value,
  ).id;
  const subscriptions = new Subscriptions(store, now);
  const handle = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/events" && request.method === "GET") {
        if (
          !equalSecret(
            request.headers.get("authorization") ?? "",
            `Bearer ${options.retrievalToken}`,
          )
        )
          return new Response("Unauthorized", { status: 401 });
        const raw = url.searchParams.get("after") ?? "0";
        if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
          return new Response("Invalid cursor", { status: 400 });
        const events = (
          store.db
            .prepare(
              "SELECT body FROM documents WHERE kind='websub-events' AND id>? ORDER BY id LIMIT 100",
            )
            .all(String(Number(raw)).padStart(16, "0")) as { body: string }[]
        ).map((row) => JSON.parse(row.body) as ReceiverEvent);
        return Response.json(
          {
            receiverId,
            events,
            nextCursor: events.at(-1)?.sequence ?? Number(raw),
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
      const channelId = /^\/callback\/(UC[\w-]{22})$/.exec(url.pathname)?.[1];
      if (!channelId) return new Response("Not found", { status: 404 });
      const sub = subscriptions.get(channelId);
      if (
        !sub ||
        !equalSecret(url.searchParams.get("token") ?? "", sub.callbackToken)
      )
        return new Response("Forbidden", { status: 403 });
      if (request.method === "GET") {
        const challenge = subscriptions.confirm(channelId, url.searchParams);
        return challenge === undefined
          ? new Response("Forbidden", { status: 403 })
          : new Response(challenge, {
              headers: {
                "content-type": "application/octet-stream",
                "x-content-type-options": "nosniff",
                "cache-control": "no-store",
              },
            });
      }
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      if (!sub.activeUntil || sub.activeUntil <= now())
        return new Response("Subscription expired", { status: 403 });
      const signature = /^(sha1|sha256|sha384|sha512)=([a-f\d]+)$/.exec(
        request.headers.get("x-hub-signature") ?? "",
      );
      if (!signature) return new Response("Invalid signature", { status: 403 });
      const body = await boundedBody(request);
      if (
        !equalSecret(
          createHmac(signature[1]!, sub.secret).update(body).digest("hex"),
          signature[2]!,
        )
      )
        return new Response("Invalid signature", { status: 403 });
      const entries = parseEvents(body, sub);
      store.transaction(() => {
        for (const entry of entries) {
          const digest = createHash("sha256")
            .update(`${sub.topic}:${entry.videoId}:${entry.updatedAt}`)
            .digest("hex");
          if (!store.claim("websub-event", digest, digest)) continue;
          const sequence = store.mutate<number>(
            "websub",
            "sequence",
            () => 0,
            (n) => n + 1,
          );
          const event: ReceiverEvent = {
            ...entry,
            id: `${receiverId}:${digest}`,
            receiverId,
            sequence,
            channelId,
            topic: sub.topic,
            receivedAt: now(),
          };
          store.save(
            "websub-events",
            String(sequence).padStart(16, "0"),
            event,
            0,
          );
        }
      });
      return new Response(null, { status: 202 });
    } catch (error) {
      if (error instanceof PayloadError)
        return new Response(error.message, { status: error.status });
      // Unexpected durable-store failures must remain retryable, without exposing paths or secrets.
      return new Response("Receiver unavailable", { status: 503 });
    }
  };
  return { handle, subscriptions, close: () => store.close() };
}
export function createEventServer(
  service: ReturnType<typeof createEventService>,
) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
          ? {}
          : {
              body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              duplex: "half",
            }),
      } as RequestInit);
      const response = await service.handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(400);
      outgoing.end("Invalid request");
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
