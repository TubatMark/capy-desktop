import type { PublicationDeliveryOptions } from "../../lib/publication";
import type { PostText } from "../../lib/types";

/** What a platform client needs to post one clip. */
export interface PostJob {
  /** Immutable delivery mode/visibility authorized by the publication gate. */
  deliveryOptions?: PublicationDeliveryOptions;
  file: string;
  /** The rendered thumbnail (.jpg next to the mp4). */
  thumbFile?: string;
  /** Seconds into the clip for the cover frame. */
  thumbAt?: number;
  text: PostText;
  /** A kids' story (YouTube: selfDeclaredMadeForKids). */
  madeForKids?: boolean;
  /** Progress saved by an earlier attempt (video id, container, publish id): resume instead of uploading again. */
  resume?: Record<string, string>;
}

export type PostOutcome =
  | { kind: "posted"; id: string; url?: string; note?: string }
  | { kind: "needs_action"; id?: string; url?: string; note: string };

export class PlatformError extends Error {
  constructor(
    message: string,
    /** Worth trying again later (network, rate limit, server error). */
    public retryable: boolean,
    /** The token was refused: the account must be reconnected. */
    public auth = false,
  ) {
    super(message);
  }
}

export interface ClientCtx {
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  /** Save progress the platform has accepted, so a retry can resume from it. */
  checkpoint?: (p: Record<string, string>) => void;
}

/** Meta Graph error codes for rate limits (app, user, page, call). */
const GRAPH_RATE = [4, 17, 32, 613];

/**
 * Turn a failed response into a PlatformError. Auth = the account must be reconnected (401; Meta code 190;
 * a 403 that isn't a quota). Retryable = try again later (429, 5xx, Meta rate limits, YouTube quota/rate).
 */
export function httpError(
  res: Response,
  body: Record<string, unknown>,
): PlatformError {
  type Err = {
    message?: string;
    code?: number | string;
    errors?: { reason?: string }[];
    is_transient?: boolean;
  };
  const err = body.error as Err | string | undefined;
  const e: Err = typeof err === "object" && err ? err : {};
  const msg =
    (typeof err === "string" ? err : e.message) ??
    (body.message as string) ??
    `HTTP ${res.status} ${res.statusText}`;
  const reason = e.errors?.[0]?.reason ?? "";
  const graphCode = typeof e.code === "number" ? e.code : undefined;
  const limited =
    /quota|rateLimit|dailyLimit/i.test(reason) ||
    (graphCode !== undefined && GRAPH_RATE.includes(graphCode)) ||
    !!e.is_transient;
  const auth =
    !limited && (res.status === 401 || graphCode === 190 || res.status === 403);
  return new PlatformError(
    String(msg),
    limited || res.status === 429 || res.status >= 500,
    auth,
  );
}

export async function readJson(
  res: Response,
): Promise<Record<string, unknown>> {
  const text = await res.text().catch((error) => {
    throw new TransportError(error);
  });
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { message: text.slice(0, 300) };
  }
}

/** fetch that turns network failures into retryable PlatformErrors. */
export async function call(
  f: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await f(url, init);
  } catch (e) {
    throw new TransportError(e);
  }
}

/** A transport failure can occur after a remote mutation accepted the bytes. */
export class TransportError extends PlatformError {
  constructor(error: unknown) {
    super(
      `Network error: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
    this.name = "TransportError";
    this.cause = error;
  }
}
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof TransportError) return true;
  if (!(error instanceof Error)) return false;
  return (
    ["AbortError", "TimeoutError", "DeadlineError"].includes(error.name) ||
    /Network error|deadline|timed out|socket hang up|fetch failed/i.test(
      error.message,
    )
  );
}
/** A remote id permits status-only resume; preparation is safe only with an explicit pre-publish phase. */
export function canResumeDelivery(
  platform: string,
  progress?: Record<string, string>,
): boolean {
  if (!progress) return false;
  if (platform === "youtube") return !!progress.videoId;
  if (platform === "tiktok") return !!progress.publishId;
  if (platform === "instagram")
    return (
      !!progress.mediaId ||
      (!!progress.container &&
        progress.uploaded === "1" &&
        progress.deliveryPhase === "prepared")
    );
  return false;
}
