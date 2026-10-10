import { it, expect, beforeEach, afterEach } from "vitest";
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
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function run(fn: () => Promise<unknown>) {
  const q = new WorkQueue(runtimeStore());
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
