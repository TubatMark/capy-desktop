import { it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { postYouTube } from "../server/platforms/youtube";
import { postInstagram } from "../server/platforms/instagram";
import { postTikTok } from "../server/platforms/tiktok";
import type { ClientCtx, RemoteObservation } from "../server/platforms/types";
let root: string, file: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "capy-upload-recovery-"));
  file = path.join(root, "v.mp4");
  writeFileSync(file, Buffer.from("0123456789"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const json = (v: unknown, status = 200) => Response.json(v, { status });
function context(fetcher: typeof fetch) {
  const progress: Record<string, string> = {},
    observations: RemoteObservation[] = [];
  let mutations = 0;
  const ctx: ClientCtx = {
    token: "fake",
    fetch: fetcher,
    sleep: async () => {},
    log: () => {},
    singlePoll: true,
    beforeMutation: () => {
      mutations++;
    },
    checkpoint: (p) => Object.assign(progress, p),
    observe: (o) => observations.push(o),
  };
  return { ctx, progress, observations, mutations: () => mutations };
}
it("lost_success_response_is_reconciled on YouTube without a second upload", async () => {
  let init = 0,
    bytes = 0,
    query = 0,
    accepted = false;
  const c = context((async (url, request) => {
    if (String(url).includes("uploadType=")) {
      init++;
      return new Response(null, {
        headers: { location: "https://fixture/session" },
      });
    }
    if (String(url) === "https://fixture/session") {
      expect(c.progress.session).toBe(String(url));
      if (new Headers(request?.headers).get("content-length") === "0") {
        query++;
        return json({ id: "video1" });
      }
      bytes++;
      accepted = true;
      throw Error("lost final success body");
    }
    return json({
      items: [
        { status: { uploadStatus: "processed", privacyStatus: "public" } },
      ],
    });
  }) as typeof fetch);
  await expect(postYouTube({ file, text: {} }, c.ctx)).rejects.toThrow();
  expect(accepted).toBe(true);
  const result = await postYouTube(
    { file, text: {}, resume: { ...c.progress } },
    c.ctx,
  );
  expect(result.kind).toBe("posted");
  expect({ init, bytes, query }).toEqual({ init: 1, bytes: 1, query: 1 });
  expect(c.observations.at(-1)?.visibility).toBe("public");
});
it("a partial YouTube session resumes only the independently reported missing bytes", async () => {
  let received = "";
  const c = context((async (url, request) => {
    if (String(url) === "https://fixture/session") {
      if (new Headers(request?.headers).get("content-length") === "0")
        return new Response(null, {
          status: 308,
          headers: { range: "bytes=0-3" },
        });
      received = Buffer.from(
        await (request!.body as Blob).arrayBuffer(),
      ).toString();
      expect(new Headers(request?.headers).get("content-range")).toBe(
        "bytes 4-9/10",
      );
      return json({ id: "video2" });
    }
    return json({
      items: [
        { status: { uploadStatus: "processed", privacyStatus: "private" } },
      ],
    });
  }) as typeof fetch);
  const result = await postYouTube(
    { file, text: {}, resume: { session: "https://fixture/session" } },
    c.ctx,
  );
  expect(received).toBe("456789");
  expect(result.kind).toBe("needs_action");
  expect(result.note).not.toMatch(/not audited|unaudited/);
  expect(c.observations.at(-1)?.visibility).toBe("private");
});
it("expired possibly accepted session stays unknown and never initializes again", async () => {
  let calls = 0;
  const c = context((async () => {
    calls++;
    return new Response(null, { status: 404 });
  }) as typeof fetch);
  await expect(
    postYouTube(
      { file, text: {}, resume: { session: "https://fixture/session" } },
      c.ctx,
    ),
  ).rejects.toMatchObject({ name: "DeliveryUnknownError" });
  expect(calls).toBe(1);
  expect(c.mutations()).toBe(0);
});
it("Instagram publish response loss queries the existing container and never repeats media_publish", async () => {
  let mutations = 0;
  const c = context((async (url, request) => {
    if (request?.method === "POST") mutations++;
    return json({ status_code: "FINISHED" });
  }) as typeof fetch);
  await postInstagram(
    {
      file,
      text: {},
      resume: {
        container: "container1",
        uploaded: "1",
        deliveryPhase: "attempted",
      },
    },
    { ...c.ctx, igUserId: "account" },
  );
  expect(mutations).toBe(0);
  expect(c.observations.at(-1)?.state).toBe("delivery-unknown");
});
it("TikTok saves publish identifier before a lost upload response and reconciles inbox", async () => {
  let initialized = 0,
    transfers = 0;
  const c = context((async (url) => {
    if (String(url).includes("/init/")) {
      initialized++;
      return json({
        data: { publish_id: "p1", upload_url: "https://fixture/upload" },
        error: { code: "ok" },
      });
    }
    if (String(url) === "https://fixture/upload") {
      transfers++;
      expect(c.progress.publishId).toBe("p1");
      throw Error("lost acceptance");
    }
    return json({
      data: { status: "SEND_TO_USER_INBOX" },
      error: { code: "ok" },
    });
  }) as typeof fetch);
  await expect(
    postTikTok({ file, text: {} }, { ...c.ctx, mode: "inbox" }),
  ).rejects.toThrow();
  await postTikTok(
    { file, text: {}, resume: { ...c.progress } },
    { ...c.ctx, mode: "inbox", reconcileOnly: true },
  );
  expect({ initialized, transfers }).toEqual({ initialized: 1, transfers: 1 });
  expect(c.observations.at(-1)?.visibility).toBe("inbox");
});
it("saved remote completion without public IDs is not assumed public", async () => {
  const c = context((async () =>
    json({
      data: { status: "PUBLISH_COMPLETE" },
      error: { code: "ok" },
    })) as typeof fetch);
  const result = await postTikTok(
    { file, text: {}, resume: { publishId: "p", privacy: "SELF_ONLY" } },
    { ...c.ctx, mode: "direct", reconcileOnly: true },
  );
  expect(result.kind).toBe("needs_action");
  expect(c.observations.at(-1)?.visibility).toBe("private");
  expect(result.note).not.toContain("audited");
});

it("YouTube only reports scheduled when the server echoes the exact approved future time", async () => {
  const publishAt = Date.now() + 3600000;
  let echo = publishAt + 1;
  const c = context((async () =>
    json({
      items: [
        {
          status: {
            uploadStatus: "processed",
            privacyStatus: "private",
            publishAt: new Date(echo).toISOString(),
          },
        },
      ],
    })) as typeof fetch);
  const job = {
    file,
    text: {},
    resume: { videoId: "scheduled-video" },
    deliveryOptions: {
      mode: "scheduled" as const,
      privacyPolicy: "private-until-publish" as const,
      publishAt,
      uploadAheadMinutes: 60,
      schedulePolicy: "youtube-schedule-v1" as const,
    },
  };
  await postYouTube(job, c.ctx);
  expect(c.observations.at(-1)?.visibility).toBe("private");
  echo = publishAt;
  await postYouTube(job, c.ctx);
  expect(c.observations.at(-1)?.visibility).toBe("scheduled");
});
