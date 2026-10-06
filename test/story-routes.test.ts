import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  init: async () => {},
  listSeries: () => [],
  getSeries: (id: string) => (id === "ser1" ? { id: "ser1", title: "Pip", characters: [] } : undefined),
  listStories: () => [],
  getStory: (id: string) => (id === "st1" ? { id: "st1", seriesId: "ser1", status: "script", pages: [] } : undefined),
  createSeries: async (n: unknown) => ({ id: "ser2", ...(n as object) }),
  createStory: async () => ({ id: "st2" }),
  approveScript: async () => {
    throw Object.assign(new Error("This story is busy."), { status: 409 });
  },
  render: async (_id: string, voice: string) => ({ id: "st1", voice }),
}));
vi.mock("../server/stories", () => ({ stories: () => m }));
vi.mock("../src/story/narrate", async (orig) => ({ ...(await orig<typeof import("../src/story/narrate")>()), listVoices: async () => [{ name: "Samantha", lang: "en_US" }] }));

import { GET as listRoute, POST as createSeriesRoute } from "../app/api/stories/route";
import { GET as storyGet } from "../app/api/stories/story/[id]/route";
import { POST as storyAction } from "../app/api/stories/story/[id]/[action]/route";

const req = (url: string, method = "GET", body?: unknown) => new Request(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });

describe("story routes", () => {
  it("lists series with the available voices", async () => {
    expect(await (await listRoute()).json()).toEqual({ series: [], voices: [{ name: "Samantha", lang: "en_US" }] });
  });
  it("validates a new series", async () => {
    expect((await createSeriesRoute(req("/api/stories", "POST", { title: "" }))).status).toBe(400);
    const ok = await createSeriesRoute(req("/api/stories", "POST", { title: "Pip & Lulu", ageBand: "2-4", tone: "gentle", values: ["sharing"], artStyle: "flat", characters: [{ name: "Pip", description: "a penguin" }] }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe("ser2");
  });
  it("404s an unknown story and passes the manager's 409 through", async () => {
    expect((await storyGet(req("/x"), params({ id: "nope" }))).status).toBe(404);
    expect((await storyAction(req("/x", "POST", {}), params({ id: "st1", action: "approve" }))).status).toBe(409);
    expect((await storyAction(req("/x", "POST", {}), params({ id: "st1", action: "explode" }))).status).toBe(400);
    const r = await storyAction(req("/x", "POST", { voice: "Samantha" }), params({ id: "st1", action: "render" }));
    expect(await r.json()).toMatchObject({ voice: "Samantha" });
  });
});
