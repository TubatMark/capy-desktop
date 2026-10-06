import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  edit: true,
  updates: [] as unknown[],
  state: async (o: { refresh?: boolean }) => ({ access: { connected: true, read: true, analytics: false, edit: true }, snapshot: null, refreshed: !!o.refresh }),
}));
vi.mock("../server/channel", () => ({
  channelState: (o: { refresh?: boolean }) => h.state(o),
  channelAccess: () => ({ connected: true, read: true, analytics: true, edit: h.edit }),
  loadSnapshot: async () => ({ videos: [{ id: "v1", title: "Old", description: "", tags: [], duration: 30 }] }),
  updateVideoText: async (_d: unknown, id: string, t: unknown) => {
    h.updates.push(t);
    return { id, ...(t as object) };
  },
  replaceVideo: async () => {},
}));
vi.mock("../server/accounts", () => ({ getAccessToken: async () => "T" }));
vi.mock("../server/seo", async (orig) => ({
  ...(await orig<typeof import("../server/seo")>()),
  research: async (q: string) => ({ seed: q, keywords: [], ranking: [], tags: [], notes: [], at: 0 }),
  suggestForVideo: async (v: { id: string }) => ({ videoId: v.id }),
  appAi: () => ({ agent: "claude" }),
}));

import { GET as channelGet } from "../app/api/channel/route";
import { GET as keywordsGet } from "../app/api/channel/keywords/route";
import { POST as seoPost } from "../app/api/channel/videos/[id]/seo/route";
import { PUT as videoPut } from "../app/api/channel/videos/[id]/route";

const req = (url: string, method = "GET", body?: unknown) => new Request(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });

describe("channel routes", () => {
  it("returns the channel state, refreshing on request", async () => {
    expect((await (await channelGet(req("/api/channel"))).json()).refreshed).toBe(false);
    expect((await (await channelGet(req("/api/channel?refresh=1"))).json()).refreshed).toBe(true);
  });

  it("researches a topic, rejecting an empty one", async () => {
    expect((await keywordsGet(req("/api/channel/keywords?q=x"))).status).toBe(400);
    expect((await (await keywordsGet(req("/api/channel/keywords?q=bedtime%20story"))).json()).seed).toBe("bedtime story");
  });

  it("suggests for a known video and 404s an unknown one", async () => {
    expect((await seoPost(req("/x", "POST"), params({ id: "nope" }))).status).toBe(404);
    expect(await (await seoPost(req("/x", "POST"), params({ id: "v1" }))).json()).toEqual({ videoId: "v1" });
  });

  it("updates a video's text only with the edit permission; hashtags land in the description", async () => {
    h.edit = false;
    expect((await videoPut(req("/x", "PUT", { title: "T", description: "D", tags: [] }), params({ id: "v1" }))).status).toBe(403);
    h.edit = true;
    const r = await videoPut(req("/x", "PUT", { title: "New title", description: "Story.", hashtags: ["bedtimestory", "shorts"], tags: ["a", "b"] }), params({ id: "v1" }));
    expect(r.status).toBe(200);
    expect(h.updates.at(-1)).toEqual({ title: "New title", description: "Story.\n\n#bedtimestory #shorts", tags: ["a", "b"] });
    expect((await videoPut(req("/x", "PUT", { title: "" }), params({ id: "v1" }))).status).toBe(400);
  });
});
