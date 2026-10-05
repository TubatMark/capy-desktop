import type { PostText } from "../../lib/types";

/** What a platform client needs to post one clip. */
export interface PostJob {
  file: string;
  /** The rendered thumbnail (.jpg next to the mp4). */
  thumbFile?: string;
  /** Seconds into the clip for the cover frame. */
  thumbAt?: number;
  text: PostText;
}

export type PostOutcome = { kind: "posted"; id: string; url?: string; note?: string } | { kind: "needs_action"; id?: string; url?: string; note: string };

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
}

/** Turn a failed response into a PlatformError: 401/403 = auth, 429/5xx = retryable. */
export function httpError(res: Response, body: Record<string, unknown>): PlatformError {
  const err = body.error as { message?: string; code?: string } | string | undefined;
  const msg = (typeof err === "string" ? err : err?.message) ?? (body.message as string) ?? `HTTP ${res.status} ${res.statusText}`;
  const auth = res.status === 401 || res.status === 403;
  return new PlatformError(String(msg), res.status === 429 || res.status >= 500, auth);
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { message: text.slice(0, 300) };
  }
}

/** fetch that turns network failures into retryable PlatformErrors. */
export async function call(f: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await f(url, init);
  } catch (e) {
    throw new PlatformError(`Network error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
