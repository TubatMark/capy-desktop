import {
  getReadingAccessToken,
  loadReadingAccount,
  saveReadingAccount,
} from "../accounts";
import {
  parseDiscoveryVideos,
  type DiscoveryVideo,
} from "../../src/youtube-api";

export type VideoReadiness = {
  status: "ready" | "wait-until" | "unavailable" | "excluded";
  reason: string;
  retryAt?: number;
  video?: DiscoveryVideo;
};
export interface ReadinessDeps {
  accountId?: string;
  channelId?: string;
  minVideoSec?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
}
export interface YoutubePage {
  nextPageToken?: string;
  items?: {
    id?: string;
    snippet?: { resourceId?: { videoId?: string } };
    contentDetails?: {
      videoId?: string;
      relatedPlaylists?: { uploads?: string };
    };
  }[];
  error?: { message?: string; errors?: { reason?: string }[] };
}
/** Bound both fetch and body reads; a transport ignoring abort cannot hold a worker indefinitely. */
export async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("Discovery cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export async function readResponseBody(
  response: Response,
  signal: AbortSignal,
  limit = 2 * 1024 * 1024,
): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > limit)
    throw Error("Discovery response exceeds limit");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      length += part.value.length;
      if (length > limit) throw Error("Discovery response exceeds limit");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export async function readYoutube(
  accountId: string,
  resource: string,
  params: Record<string, string>,
  deps: ReadinessDeps = {},
): Promise<YoutubePage> {
  const signal = deps.signal ?? AbortSignal.timeout(30_000);
  const transport = deps.fetch ?? fetch;
  const boundedFetch: typeof fetch = (input, init) =>
    abortable(transport(input, { ...init, signal }), signal);
  const token = await abortable(
    getReadingAccessToken(accountId, boundedFetch),
    signal,
  );
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  url.search = new URLSearchParams(params).toString();
  const response = await boundedFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  // videos.list is capped at 50, so a multi-megabyte body is a provider error, not valid discovery.
  const body = await readResponseBody(response, signal);
  const data = JSON.parse(body) as YoutubePage;
  if (
    loadReadingAccount().account?.id !== accountId ||
    loadReadingAccount().needsReconnect
  )
    throw Error(
      "The original YouTube reading account changed; reconnect it before discovering uploads",
    );
  if (!response.ok || data.error) {
    if (response.status === 401) saveReadingAccount({ needsReconnect: true });
    throw Object.assign(Error(data.error?.message ?? `YouTube discovery failed (${response.status})`), {
      providerReason: data.error?.errors?.[0]?.reason,
    });
  }
  return data;
}
/** Shorts have no authoritative Data API format flag; use the creator's explicit minimum-duration filter. */
export function classifyReadiness(
  video: DiscoveryVideo | undefined,
  deps: ReadinessDeps = {},
): VideoReadiness {
  const wait = (reason: string): VideoReadiness => ({
    status: "wait-until",
    reason,
    retryAt: Math.max(
      (deps.now?.() ?? new Date()).getTime() + 5 * 60_000,
      video?.scheduledAt ?? 0,
    ),
    video,
  });
  if (!video)
    return {
      status: "unavailable",
      reason:
        "Video is deleted, private, or inaccessible to the reading account",
    };
  if (deps.channelId && video.channelId && video.channelId !== deps.channelId)
    return {
      status: "excluded",
      reason: "Video belongs to a different source channel",
      video,
    };
  if (video.privacy && video.privacy !== "public")
    return {
      status: "unavailable",
      reason: `${video.privacy} video is not publicly available`,
      video,
    };
  if (video.broadcast === "live")
    return wait("Live stream is still running; wait for its archive");
  if (video.broadcast === "upcoming")
    return wait("Premiere or scheduled live stream has not finished");
  if (
    video.uploadStatus &&
    !["processed", "uploaded"].includes(video.uploadStatus)
  )
    return {
      status: "unavailable",
      reason: `YouTube upload is ${video.uploadStatus}`,
      video,
    };
  if (
    video.uploadStatus === "uploaded" ||
    video.duration === undefined ||
    video.duration <= 0
  )
    return wait("Video duration or processing is not ready");
  if (video.duration < (deps.minVideoSec ?? 240))
    return {
      status: "excluded",
      reason: `Below the creator's minimum duration (${deps.minVideoSec ?? 240}s); short uploads and Shorts are filtered by duration`,
      video,
    };
  return { status: "ready", reason: "Public video is ready", video };
}
export async function checkVideoReadiness(
  videoId: string,
  deps: ReadinessDeps = {},
): Promise<VideoReadiness> {
  const accountId = deps.accountId ?? loadReadingAccount().account?.id;
  if (!accountId)
    throw Error("Connect the YouTube reading account to check readiness");
  const body = await readYoutube(
    accountId,
    "videos",
    { part: "snippet,contentDetails,status,liveStreamingDetails", id: videoId },
    deps,
  );
  return classifyReadiness(
    parseDiscoveryVideos(body as Record<string, unknown>).find(
      (v) => v.id === videoId,
    ),
    deps,
  );
}
