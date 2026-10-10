import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicationFixture } from "./publication-fixtures";
import { decide } from "../server/publication-policy";
import { queue, upsertForRender, resetQueueCache } from "../server/queue";
import { runtimeStore } from "../server/db/runtime";
import { WorkQueue } from "../server/worker/leases";
import { withWork } from "../server/worker/context";
import { deliverPackage, reconcileDelivery } from "../server/delivery";
import {
  deliveryForPackage,
  readDeliveryHandles,
} from "../server/delivery-store";
import { saveAccount } from "../server/accounts";
let root: string, file: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "capy-delivery-worker-"));
  process.env.CAPY_DATA_DIR = root;
  resetQueueCache();
  file = publicationFixture().file;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
async function run(fn: () => Promise<unknown>) {
  const q = new WorkQueue(runtimeStore(), { leaseMs: 600000 });
  await q.enqueue({
    kind: "fixture",
    workKey: `delivery-${Math.random()}`,
    inputRevision: 1,
    payload: {},
  });
  const lease = await q.claim("test", Date.now());
  if (!lease) throw Error("no lease");
  return withWork(
    { queue: q, lease, workspace: root, signal: new AbortController().signal },
    fn,
  );
}
function seed() {
  const e = {
    ...decide(
      upsertForRender(
        [],
        {
          publicationFiles: { file },
          jobId: "j",
          n: 1,
          start: 0,
          end: 30,
          clipTitle: "c",
          videoUrl: "/v",
        },
        ["youtube"],
        new Date(),
      )[0]!,
      false,
      new Date(),
    ),
    status: "scheduled" as const,
    slotAt: Date.now(),
  };
  queue().mutate(() => [e]);
  return e;
}
it("destination_and_revision_rechecked_at_upload after token acquisition", async () => {
  const e = seed();
  let calls = 0;
  await run(async () => {
    await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
      fetch: (async () => {
        calls++;
        return Response.json({});
      }) as typeof fetch,
      token: async () => {
        saveAccount("youtube", { account: { id: "other", name: "other" } });
        return "fake";
      },
    });
  });
  expect(calls).toBe(0);
  expect(queue().list()[0]?.delivery?.state).toBe("needs-action");
});
it("changed video bytes after approval refuse initialization", async () => {
  const e = seed();
  let calls = 0;
  await run(async () => {
    await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
      fetch: (async () => {
        calls++;
        return Response.json({});
      }) as typeof fetch,
      token: async () => {
        writeFileSync(file, "changed");
        return "fake";
      },
    });
  });
  expect(calls).toBe(0);
  expect(queue().list()[0]?.delivery?.state).toBe("needs-action");
});
it("lost final acceptance is durably reconciled with one session and public proof", async () => {
  const e = seed();
  let inits = 0,
    uploads = 0;
  let accepted = false;
  const fetcher = (async (url, init) => {
    if (String(url).includes("uploadType=")) {
      inits++;
      return new Response(null, {
        headers: { location: "https://fixture/session" },
      });
    }
    if (String(url) === "https://fixture/session") {
      if (new Headers(init?.headers).get("content-length") === "0")
        return Response.json({ id: "v1" });
      uploads++;
      accepted = true;
      throw Error("lost success");
    }
    return Response.json({
      items: [
        { status: { uploadStatus: "processed", privacyStatus: "public" } },
      ],
    });
  }) as typeof fetch;
  await run(async () => {
    expect(
      await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
        fetch: fetcher,
        token: async () => "fake",
      }),
    ).toBe("delivery-unknown");
    const d = deliveryForPackage(e.publishPackage!.packageHash)!;
    expect(readDeliveryHandles(d).session).toBe("https://fixture/session");
    expect(
      await reconcileDelivery(d.id, {
        fetch: fetcher,
        token: async () => "fake",
      }),
    ).toBe("public");
  });
  expect(accepted).toBe(true);
  expect({ inits, uploads }).toEqual({ inits: 1, uploads: 1 });
  expect(queue().list()[0]?.delivery?.publicationIds).toEqual(["v1"]);
});
it("a pause appearing after session initialization blocks the next byte mutation", async () => {
  const e = seed();
  let calls = 0;
  const { saveSettings } = await import("../server/settings");
  await run(async () => {
    await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
      token: async () => "fake",
      fetch: (async () => {
        calls++;
        saveSettings({ postingPaused: true });
        return new Response(null, {
          headers: { location: "https://fixture/session" },
        });
      }) as typeof fetch,
    });
  });
  expect(calls).toBe(1);
});

it("a saved operation cannot switch client credentials even on the same account", async () => {
  const e = seed();
  let calls = 0;
  const fetcher = (async (url) => {
    calls++;
    if (String(url).includes("uploadType="))
      return new Response(null, {
        headers: { location: "https://fixture/session" },
      });
    throw Error("lost success");
  }) as typeof fetch;
  await run(async () => {
    await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
      fetch: fetcher,
      token: async () => "fake",
    });
    const d = deliveryForPackage(e.publishPackage!.packageHash)!;
    saveAccount("youtube", { clientId: "replaced-client" });
    const before = calls;
    expect(
      await reconcileDelivery(d.id, {
        fetch: fetcher,
        token: async () => "fake",
      }),
    ).toBe("needs-action");
    expect(calls).toBe(before);
  });
});
it("a rejected initialization waits for the quota window and can safely use a new session", async () => {
  const e = seed();
  let calls = 0;
  const fetcher = (async (url) => {
    calls++;
    if (calls === 1)
      return Response.json(
        { error: { errors: [{ reason: "quotaExceeded" }] } },
        { status: 403 },
      );
    if (String(url).includes("uploadType="))
      return new Response(null, {
        headers: { location: "https://fixture/session" },
      });
    if (String(url) === "https://fixture/session")
      return Response.json({ id: "quota-retry" });
    return Response.json({
      items: [
        { status: { uploadStatus: "processed", privacyStatus: "public" } },
      ],
    });
  }) as typeof fetch;
  await run(async () => {
    expect(
      await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
        fetch: fetcher,
        token: async () => "fake",
      }),
    ).toBe("failed");
    let d = deliveryForPackage(e.publishPackage!.packageHash)!;
    expect(d.phase).toBe("initialization-rejected");
    expect(d.retryClass).toBe("quota");
    expect(d.nextTryAt).toBeGreaterThan(Date.now());
    const { updateDelivery } = await import("../server/delivery-store");
    updateDelivery(d.id, (x) => ({ ...x, nextTryAt: Date.now() - 1 }));
    expect(
      await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
        fetch: fetcher,
        token: async () => "fake",
      }),
    ).toBe("public");
    d = deliveryForPackage(e.publishPackage!.packageHash)!;
    expect(d.publicationIds).toEqual(["quota-retry"]);
  });
});
it("status-only recovery can establish lost success after local video disappears", async () => {
  const e = seed();
  const fetcher = (async (url, init) => {
    if (String(url).includes("uploadType="))
      return new Response(null, {
        headers: { location: "https://fixture/session" },
      });
    if (String(url) === "https://fixture/session") {
      if (new Headers(init?.headers).get("content-length") === "0")
        return Response.json({ id: "missing-local" });
      throw Error("lost success");
    }
    return Response.json({
      items: [
        { status: { uploadStatus: "processed", privacyStatus: "public" } },
      ],
    });
  }) as typeof fetch;
  await run(async () => {
    await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
      fetch: fetcher,
      token: async () => "fake",
    });
    rmSync(file);
    const d = deliveryForPackage(e.publishPackage!.packageHash)!;
    expect(
      await reconcileDelivery(d.id, {
        fetch: fetcher,
        token: async () => "fake",
      }),
    ).toBe("public");
  });
});

it("the real poster worker leaves future public approvals due-time only", async () => {
  const e = seed();
  queue().mutate(() => [{ ...e, slotAt: Date.now() + 3600000 }]);
  const { tick } = await import("../server/poster");
  let calls = 0;
  const old = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    throw Error("fixture denies network");
  }) as typeof fetch;
  try {
    await run(() => tick());
    expect(calls).toBe(0);
    expect(deliveryForPackage(e.publishPackage!.packageHash)).toBeUndefined();
  } finally {
    globalThis.fetch = old;
  }
});

it("reject revokes a deferred quota delivery and its future retry", async () => {
  const e = seed();
  const { reject } = await import("../server/queue");
  const { tickDeliveries } = await import("../server/delivery");
  let requests = 0;
  const fetcher = (async () => {
    requests++;
    return Response.json(
      { error: { errors: [{ reason: "quotaExceeded" }] } },
      { status: 403 },
    );
  }) as typeof fetch;
  await run(async () => {
    await deliverPackage(e.publishPackage!.id, new AbortController().signal, {
      fetch: fetcher,
      token: async () => "fake",
    });
    expect(
      deliveryForPackage(e.publishPackage!.packageHash)!.nextTryAt,
    ).toBeGreaterThan(Date.now());
    queue().mutate((all) => reject(all, e.key, new Date()));
    expect(
      deliveryForPackage(e.publishPackage!.packageHash)!.nextTryAt,
    ).toBeUndefined();
    expect(queue().list()[0]!.publicationDecision).toBeUndefined();
    vi.stubGlobal("fetch", fetcher);
    try {
      await tickDeliveries(new AbortController().signal);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(requests).toBe(1);
    expect(queue().list()[0]!.status).toBe("rejected");
  });
});
it("reject while token acquisition is held forbids initialization and preserves rejection", async () => {
  const e = seed();
  const { reject } = await import("../server/queue");
  let release!: (v: string) => void;
  const token = new Promise<string>((r) => (release = r));
  let acquired!: () => void;
  const started = new Promise<void>((r) => (acquired = r));
  let requests = 0;
  await run(async () => {
    const pending = deliverPackage(
      e.publishPackage!.id,
      new AbortController().signal,
      {
        fetch: (async () => {
          requests++;
          return Response.json({});
        }) as typeof fetch,
        token: async () => {
          acquired();
          return token;
        },
      },
    );
    await started;
    queue().mutate((all) => reject(all, e.key, new Date()));
    release("fake");
    await pending;
    expect(requests).toBe(0);
    expect(queue().list()[0]!.status).toBe("rejected");
  });
});
it("expired scheduled session permits a status query but no resumed bytes", async () => {
  const e = seed();
  const { approveRemoteSchedule } = await import("../server/delivery-schedule");
  const { destinationClientIdentity } =
    await import("../server/platform-capabilities");
  const { loadAccounts } = await import("../server/accounts");
  const { tickDeliveries } = await import("../server/delivery");
  const originalNow = Date.now();
  runtimeStore().put("destination-capabilities", "youtube:fixture-account", {
    accountId: "fixture-account",
    clientIdentity: destinationClientIdentity(
      "youtube",
      loadAccounts().youtube,
    ),
    checkedAt: originalNow,
    schedulingVerified: true,
  });
  const scheduled = approveRemoteSchedule(e.key, {
    publishAt: originalNow + 180000,
    uploadAheadMinutes: 10,
    acknowledgeRemoteSchedule: true,
  });
  let initializations = 0,
    bytes = 0,
    queries = 0;
  const fetcher = (async (url, init) => {
    if (String(url).includes("uploadType=")) {
      initializations++;
      return new Response(null, {
        headers: { location: "https://fixture/session" },
      });
    }
    if (new Headers(init?.headers).get("content-length") === "0") {
      queries++;
      return new Response(null, {
        status: 308,
        headers: { range: "bytes=0-3" },
      });
    }
    bytes++;
    throw Error("lost transfer");
  }) as typeof fetch;
  await run(async () => {
    await deliverPackage(
      scheduled.publishPackage!.id,
      new AbortController().signal,
      { fetch: fetcher, token: async () => "fake" },
    );
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 240000);
    const d = deliveryForPackage(scheduled.publishPackage!.packageHash)!;
    await reconcileDelivery(d.id, {
      fetch: fetcher,
      token: async () => "fake",
    });
    const { updateDelivery } = await import("../server/delivery-store");
    updateDelivery(d.id, (x) => ({ ...x, nextTryAt: Date.now() - 1 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await tickDeliveries(new AbortController().signal);
    } finally {
      vi.unstubAllGlobals();
    }
    expect({ initializations, bytes, queries }).toEqual({
      initializations: 1,
      bytes: 1,
      queries: 2,
    });
    expect(
      deliveryForPackage(scheduled.publishPackage!.packageHash)!.reason,
    ).toMatch(/expired/);
  });
});
it("TikTok partial acceptance becomes resumable on a later production worker pass", async () => {
  const { truncateSync } = await import("node:fs");
  truncateSync(file, 65 * 1024 * 1024);
  const e = {
    ...decide(
      upsertForRender(
        [],
        {
          publicationFiles: { file },
          jobId: "tt",
          n: 1,
          start: 0,
          end: 30,
          clipTitle: "TikTok",
        },
        ["tiktok"],
        new Date(),
      )[0]!,
      false,
      new Date(),
    ),
    status: "scheduled" as const,
    slotAt: Date.now(),
  };
  queue().mutate(() => [e]);
  const { tickDeliveries } = await import("../server/delivery");
  const { updateDelivery } = await import("../server/delivery-store");
  let inits = 0,
    accepted = 0;
  const ranges: string[] = [];
  const fetcher = (async (url, init) => {
    if (String(url).includes("/init/")) {
      inits++;
      return Response.json({
        data: { publish_id: "partial", upload_url: "https://fixture/upload" },
        error: { code: "ok" },
      });
    }
    if (String(url) === "https://fixture/upload") {
      const range = new Headers(init?.headers).get("content-range")!;
      ranges.push(range);
      const end = Number(/-(\d+)\//.exec(range)![1]) + 1;
      accepted = end;
      if (ranges.length === 1) throw Error("lost first chunk response");
      return new Response(null);
    }
    return Response.json({
      data:
        accepted === 65 * 1024 * 1024
          ? { status: "SEND_TO_USER_INBOX" }
          : { status: "PROCESSING_UPLOAD", uploaded_bytes: accepted },
      error: { code: "ok" },
    });
  }) as typeof fetch;
  vi.stubGlobal("fetch", fetcher);
  try {
    await run(async () => {
      await tickDeliveries(new AbortController().signal);
      let d = deliveryForPackage(e.publishPackage!.packageHash)!;
      expect(d.state).toBe("delivery-unknown");
      updateDelivery(d.id, (x) => ({ ...x, nextTryAt: Date.now() - 1 }));
      await tickDeliveries(new AbortController().signal);
      d = deliveryForPackage(e.publishPackage!.packageHash)!;
      expect(d.state).toBe("uploading");
      expect(readDeliveryHandles(d).confirmedUploadOffset).toBe(
        String(10 * 1024 * 1024),
      );
      updateDelivery(d.id, (x) => ({ ...x, nextTryAt: Date.now() - 1 }));
      await tickDeliveries(new AbortController().signal);
      expect(
        deliveryForPackage(e.publishPackage!.packageHash)!.visibility,
      ).toBe("inbox");
      expect(inits).toBe(1);
      expect(ranges.length).toBe(6);
      expect(ranges[1]).toMatch(/^bytes 10485760-/);
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([false, true])(
  "crash after video acknowledgement recovers thumbnail once (remote schedule: %s)",
  async (scheduled) => {
    const thumb = path.join(root, "selected.jpg");
    writeFileSync(thumb, "approved thumbnail bytes");
    let e: import("../lib/types").QueueEntry = seed();
    e = {
      ...decide(
        { ...e, publicationFiles: { file, thumbFile: thumb } },
        false,
        new Date(),
      ),
      status: "scheduled",
      slotAt: Date.now(),
    };
    queue().mutate(() => [e]);
    const initialNow = Date.now();
    if (scheduled) {
      const { approveRemoteSchedule } =
        await import("../server/delivery-schedule");
      const { destinationClientIdentity } =
        await import("../server/platform-capabilities");
      const { loadAccounts } = await import("../server/accounts");
      runtimeStore().put(
        "destination-capabilities",
        "youtube:fixture-account",
        {
          accountId: "fixture-account",
          clientIdentity: destinationClientIdentity(
            "youtube",
            loadAccounts().youtube,
          ),
          checkedAt: initialNow,
          schedulingVerified: true,
        },
      );
      approveRemoteSchedule(e.key, {
        publishAt: initialNow + 180000,
        uploadAheadMinutes: 10,
        acknowledgeRemoteSchedule: true,
      });
      e = queue().list()[0]!;
    }
    const store = await import("../server/delivery-store");
    const { tickDeliveries } = await import("../server/delivery");
    const original = store.saveDeliveryHandles;
    const aborted = new AbortController();
    let thumbCalls = 0,
      initializationCalls = 0,
      byteCalls = 0;
    let thumbBytes = "";
    const fetcher = (async (url, init) => {
      if (String(url).includes("uploadType=")) {
        initializationCalls++;
        return new Response(null, {
          headers: { location: "https://fixture/session" },
        });
      }
      if (String(url) === "https://fixture/session") {
        byteCalls++;
        return Response.json({ id: "thumbnail-video" });
      }
      if (String(url).includes("thumbnails/set")) {
        thumbCalls++;
        thumbBytes = Buffer.from(
          await (init!.body as Blob).arrayBuffer(),
        ).toString();
        return Response.json({ items: [{}] });
      }
      return Response.json({
        items: [
          { status: { uploadStatus: "processed", privacyStatus: "public" } },
        ],
      });
    }) as typeof fetch;
    const spy = vi
      .spyOn(store, "saveDeliveryHandles")
      .mockImplementation((d, values, fs) => {
        const saved = original(d, values, fs);
        if (values.videoId && !values.thumbnailStatus) {
          aborted.abort(Error("crash after acknowledgement"));
          throw aborted.signal.reason;
        }
        return saved;
      });
    await run(async () => {
      await expect(
        deliverPackage(e.publishPackage!.id, aborted.signal, {
          fetch: fetcher,
          token: async () => "fake",
        }),
      ).rejects.toThrow(/crash/);
    });
    spy.mockRestore();
    if (scheduled) vi.spyOn(Date, "now").mockReturnValue(initialNow + 240000);
    expect(thumbCalls).toBe(0);
    await run(() =>
      reconcileDelivery(deliveryForPackage(e.publishPackage!.packageHash)!.id, {
        fetch: fetcher,
        token: async () => "fake",
      }),
    );
    expect(deliveryForPackage(e.publishPackage!.packageHash)!.state).toBe(
      "public",
    );
    expect(thumbCalls).toBe(0);
    vi.stubGlobal("fetch", fetcher);
    try {
      await run(() => tickDeliveries(new AbortController().signal));
      await run(() => tickDeliveries(new AbortController().signal));
    } finally {
      vi.unstubAllGlobals();
    }
    const d = deliveryForPackage(e.publishPackage!.packageHash)!;
    expect(thumbCalls).toBe(1);
    expect({ initializationCalls, byteCalls }).toEqual({
      initializationCalls: 1,
      byteCalls: 1,
    });
    expect(d.state).toBe("public");
    expect(queue().list()[0]!.status).toBe("posted");
    expect(thumbBytes).toBe("approved thumbnail bytes");
    expect(d.thumbnail).toMatchObject({
      status: "accepted",
      checksum: e.publishPackage!.thumbnail!.checksum,
    });
  },
);
it("public commit before lost queue projection is repaired with no network on the next pass", async () => {
  const e = seed();
  const store = await import("../server/delivery-store");
  const { tickDeliveries } = await import("../server/delivery");
  const original = store.updateDelivery;
  const aborted = new AbortController();
  let requests = 0;
  const fetcher = (async (url) => {
    requests++;
    if (String(url).includes("uploadType="))
      return new Response(null, {
        headers: { location: "https://fixture/session" },
      });
    if (String(url) === "https://fixture/session")
      return Response.json({ id: "public-video" });
    return Response.json({
      items: [
        { status: { uploadStatus: "processed", privacyStatus: "public" } },
      ],
    });
  }) as typeof fetch;
  const spy = vi
    .spyOn(store, "updateDelivery")
    .mockImplementation((id, change) => {
      const saved = original(id, change);
      if (saved.state === "public") {
        aborted.abort(Error("crash after public commit"));
        throw aborted.signal.reason;
      }
      return saved;
    });
  await run(async () => {
    await expect(
      deliverPackage(e.publishPackage!.id, aborted.signal, {
        fetch: fetcher,
        token: async () => "fake",
      }),
    ).rejects.toThrow(/crash/);
  });
  spy.mockRestore();
  expect(deliveryForPackage(e.publishPackage!.packageHash)!.state).toBe(
    "public",
  );
  expect(queue().list()[0]!.status).not.toBe("posted");
  const before = requests;
  vi.stubGlobal("fetch", fetcher);
  try {
    await run(() => tickDeliveries(new AbortController().signal));
  } finally {
    vi.unstubAllGlobals();
  }
  expect(queue().list()[0]!.status).toBe("posted");
  expect(queue().list()[0]!.nextTryAt).toBeUndefined();
  const { summary } = await import("../server/queue");
  expect(summary(queue().list(), new Date()).activeCount).toBe(0);
  expect(requests).toBe(before);
});
