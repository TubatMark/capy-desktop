import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../src/youtube", async (orig) => ({
  ...(await orig<typeof import("../src/youtube")>()),
  resolveChannel: async (input: string) => {
    if (input === "nope") throw new Error("Paste a YouTube channel link, an @handle, or a video from that channel.");
    return { id: "UC1", name: "Canal", handle: "@canal", url: "https://www.youtube.com/channel/UC1/videos" };
  },
  listUploads: async () => [
    { id: "v2", title: "two", duration: 600, live: false },
    { id: "v1", title: "one", duration: 500, live: false },
  ],
}));
vi.mock("../server/watcher", async (orig) => ({ ...(await orig<typeof import("../server/watcher")>()), kickWatcher: () => {}, checkNow: async () => {} }));

import { GET, PUT } from "../app/api/automation/route";
import { POST as addRoute } from "../app/api/automation/channels/route";
import { DELETE as delRoute, PATCH as patchRoute } from "../app/api/automation/channels/[id]/route";
import { resetWatchCache, watch } from "../server/watch";
import { resetSettingsCache } from "../server/settings";

let root: string;
let n = 0;
beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-auto-routes-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++n));
  resetWatchCache();
  resetSettingsCache();
});

const req = (url: string, method = "GET", body?: unknown) => new Request(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });

describe("automation routes", () => {
  it("adds a channel (baseline seen), refuses a duplicate, explains a bad input", async () => {
    const r = await addRoute(req("/api/automation/channels", "POST", { input: "@canal" }));
    expect(r.status).toBe(200);
    expect(watch().get().channels[0]).toMatchObject({ id: "UC1", seen: ["v2", "v1"], pending: [] });
    expect((await addRoute(req("/api/automation/channels", "POST", { input: "@canal" }))).status).toBe(409);
    const bad = await addRoute(req("/api/automation/channels", "POST", { input: "nope" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/channel link/);
  });
  it("clipLatest queues the newest upload", async () => {
    await addRoute(req("/api/automation/channels", "POST", { input: "@canal", clipLatest: true }));
    expect(watch().get().channels[0]!.pending.map((p) => p.id)).toEqual(["v2"]);
  });
  it("lists, patches settings, and removes", async () => {
    await addRoute(req("/api/automation/channels", "POST", { input: "@canal" }));
    const list = await (await GET()).json();
    expect(list).toMatchObject({ channels: [{ id: "UC1" }], intervalMin: 60, checking: false });
    const p = await patchRoute(req("/api/automation/channels/UC1", "PATCH", { enabled: false, settings: { clips: 5, minVideoSec: 300, perDay: 1, audience: "en-us" } }), params({ id: "UC1" }));
    expect(await p.json()).toMatchObject({ enabled: false, settings: { clips: 5, perDay: 1, audience: "en-us" } });
    expect((await patchRoute(req("/x", "PATCH", { settings: { clips: 99 } }), params({ id: "UC1" }))).status).toBe(400);
    expect((await patchRoute(req("/x", "PATCH", { enabled: true }), params({ id: "nope" }))).status).toBe(404);
    expect((await delRoute(req("/x", "DELETE"), params({ id: "UC1" }))).status).toBe(200);
    expect(watch().get().channels).toHaveLength(0);
  });
  it("sets the check interval within bounds", async () => {
    expect((await PUT(req("/api/automation", "PUT", { intervalMin: 30, maxPerDay: 4 }))).status).toBe(200);
    expect(watch().get()).toMatchObject({ intervalMin: 30, maxPerDay: 4 });
    expect((await PUT(req("/api/automation", "PUT", { intervalMin: 1 }))).status).toBe(400);
  });
});
