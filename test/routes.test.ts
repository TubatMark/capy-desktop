import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET as getQueue } from "../app/api/queue/route";
import { POST as approveRoute } from "../app/api/queue/approve/route";
import { DELETE as deleteEntry, PATCH as patchEntry } from "../app/api/queue/[key]/route";
import { POST as entryAction } from "../app/api/queue/[key]/[action]/route";
import { GET as getAccounts } from "../app/api/accounts/route";
import { PUT as putAccount } from "../app/api/accounts/[platform]/route";
import { queue, resetQueueCache, upsertForRender } from "../server/queue";
import { loadAccounts, resetAccountsCache } from "../server/accounts";
import { finishConnect, startConnect } from "../server/connect";
import { resetSettingsCache } from "../server/settings";

let root: string;
let n = 0;
beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-routes-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++n));
  resetQueueCache();
  resetAccountsCache();
  resetSettingsCache();
});

const req = (url: string, method = "GET", body?: unknown) => new Request(`http://x${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const seed = () => queue().mutate((e) => upsertForRender(e, { jobId: "J", n: 1, clipTitle: "c", publish: { ytTitle: "t", description: "d", hashtags: [] } }, ["youtube", "tiktok"], new Date()));

describe("queue routes", () => {
  it("lists an empty queue", async () => {
    const r = await getQueue();
    expect(await r.json()).toMatchObject({ entries: [], summary: { review: 0, activeCount: 0 } });
  });
  it("approves a clip into a slot, and 404s an unknown video", async () => {
    seed();
    const ok = await approveRoute(req("/api/queue/approve", "POST", { jobId: "J", n: 1, platforms: ["youtube"] }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.scheduled).toHaveLength(1);
    expect(body.scheduled[0].slotAt).toBeGreaterThan(Date.now());
    expect(queue().list().find((e) => e.platform === "tiktok")!.status).toBe("rejected");
    expect((await approveRoute(req("/api/queue/approve", "POST", { jobId: "nope" }))).status).toBe(404);
    expect((await approveRoute(req("/api/queue/approve", "POST", { jobId: 5 }))).status).toBe(400);
  });
  it("edits text, rejects, and 404s unknown keys", async () => {
    seed();
    const key = encodeURIComponent("J:1:youtube");
    const p = await patchEntry(req(`/api/queue/${key}`, "PATCH", { text: { title: "Mine" } }), params({ key }));
    expect((await p.json()).text.title).toBe("Mine");
    const rj = await entryAction(req(`/api/queue/${key}/reject`, "POST"), params({ key, action: "reject" }));
    expect((await rj.json()).status).toBe("rejected");
    expect((await deleteEntry(req("/api/queue/x", "DELETE"), params({ key: "x" }))).status).toBe(404);
    expect((await entryAction(req("/api/queue/x/explode", "POST"), params({ key, action: "explode" }))).status).toBe(400);
  });
});

describe("account routes", () => {
  it("saves app credentials, redacts the secret, and keeps it when the redacted value comes back", async () => {
    await putAccount(req("/api/accounts/youtube", "PUT", { clientId: "cid", clientSecret: "secret9876" }), params({ platform: "youtube" }));
    await putAccount(req("/api/accounts/youtube", "PUT", { clientId: "cid", clientSecret: "••••9876" }), params({ platform: "youtube" }));
    expect(loadAccounts().youtube.clientSecret).toBe("secret9876");
    const list = await (await getAccounts()).json();
    expect(list[0]).toMatchObject({ platform: "youtube", configured: true, connected: false, clientSecret: "••••9876" });
    expect((await putAccount(req("/api/accounts/myspace", "PUT", {}), params({ platform: "myspace" }))).status).toBe(404);
  });
});

describe("connect", () => {
  it("needs the app credentials first", async () => {
    await expect(startConnect("tiktok", { listen: false })).rejects.toThrow(/client/i);
  });
  it("builds the authorize URL and finishes from a pasted redirect URL", async () => {
    await putAccount(req("/api/accounts/youtube", "PUT", { clientId: "cid", clientSecret: "sec" }), params({ platform: "youtube" }));
    const { url } = await startConnect("youtube", { listen: false });
    const state = new URL(url).searchParams.get("state")!;
    const answers = [
      new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })),
      new Response(JSON.stringify({ items: [{ id: "UC1", snippet: { title: "My Channel", thumbnails: { default: { url: "a.jpg" } } } }] })),
    ];
    const f = (async () => answers.shift()!) as unknown as typeof fetch;
    await finishConnect("youtube", `http://127.0.0.1:53682/callback?state=${state}&code=C`, f);
    expect(loadAccounts().youtube).toMatchObject({ account: { id: "UC1", name: "My Channel" }, tokens: { accessToken: "AT" } });
    await expect(finishConnect("youtube", `http://127.0.0.1:53682/callback?state=${state}&code=C`, f)).rejects.toThrow(/expired|again/i);
  });
});
