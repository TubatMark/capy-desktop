import { beforeEach, afterEach, expect, it } from "vitest";
import * as nativeFs from "node:fs";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicationFixture } from "./publication-fixtures";
import { decide } from "../server/publication-policy";
import { upsertForRender } from "../server/queue";
import { runtimeStore } from "../server/db/runtime";
import { capturePublicationAttribution } from "../server/publication-attribution";
import {
  createDelivery,
  deliveryForPackage,
  readDelivery,
  saveDeliveryHandles,
  readDeliveryHandles,
  listDeliveryAttributions,
} from "../server/delivery-store";
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "capy-delivery-"));
  process.env.CAPY_DATA_DIR = root;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function entry() {
  const files = publicationFixture();
  return decide(
    upsertForRender(
      [],
      {
        publicationFiles: files,
        jobId: "J",
        n: 1,
        start: 0,
        end: 30,
        clipTitle: "clip",
        videoUrl: "/v",
      },
      ["youtube"],
      new Date(),
    )[0]!,
    false,
    new Date(),
  );
}
it("one immutable delivery claim and attribution survives repeated approval and mutable settings", () => {
  const e = entry();
  const a = createDelivery(e);
  const again = createDelivery({
    ...e,
    publishPackage: { ...e.publishPackage!, id: "new-approval-id" },
  });
  expect(again.id).toBe(a.id);
  expect(runtimeStore().list("deliveries")).toHaveLength(1);
  const snapshot = capturePublicationAttribution(e, e.publishPackage!);
  expect(snapshot.recipe.state).toBe("unattributed");
  runtimeStore().put("automation-jobs", "J", {
    recipeId: "later",
    channelId: "later",
  });
  expect(capturePublicationAttribution(e, e.publishPackage!)).toEqual(snapshot);
  expect(listDeliveryAttributions()).toEqual([
    expect.objectContaining({
      id: a.id,
      attribution: {
        packageHash: e.publishPackage!.packageHash,
        attributionHash: snapshot.attributionHash,
      },
    }),
  ]);
});
it("restricted handles recover independently from public checkpoint without leaking into projection", () => {
  const e = entry(),
    d = createDelivery(e);
  saveDeliveryHandles(d, {
    session: "https://upload.invalid/secret",
    videoId: "remote-1",
  });
  expect(readDeliveryHandles(d).session).toContain("secret");
  expect(statSync(path.join(root, "delivery-private")).mode & 0o777).toBe(
    0o700,
  );
  expect(
    statSync(path.join(root, "delivery-private", `${d.id}.json`)).mode & 0o777,
  ).toBe(0o600);
  expect(JSON.stringify(listDeliveryAttributions())).not.toMatch(
    /secret|remote-1|fixture.mp4/,
  );
  expect(readDelivery(d.id)?.phase).toBe("not-started");
  expect(() =>
    saveDeliveryHandles(
      { ...d, package: { ...d.package, accountId: "foreign" } },
      { session: "replacement" },
    ),
  ).toThrow(/identity/);
});
it("invalid package and attribution corruption fail before creating a delivery", () => {
  const e = entry();
  expect(() => createDelivery({ ...e, text: { title: "changed" } })).toThrow();
  const snapshot = capturePublicationAttribution(e, e.publishPackage!);
  runtimeStore().put("publication-attributions", snapshot.packageHash, {
    ...snapshot,
    accountId: "other",
  });
  expect(() => createDelivery(e)).toThrow(/attribution/i);
  expect(runtimeStore().list("deliveries")).toHaveLength(0);
});

it("delivery creation rolls back attribution when its durable claim cannot commit", () => {
  const e = entry(),
    store = runtimeStore(),
    original = store.put.bind(store);
  store.put = (kind, ...args) => {
    if (kind === "deliveries") throw Error("fixture disk full");
    return original(kind, ...args);
  };
  try {
    expect(() => createDelivery(e)).toThrow("fixture disk full");
  } finally {
    store.put = original;
  }
  expect(store.list("publication-attributions")).toHaveLength(0);
  expect(store.list("delivery-identities")).toHaveLength(0);
});
it("read rejects a changed attribution reference rather than exposing invented provenance", () => {
  const e = entry(),
    d = createDelivery(e);
  runtimeStore().put("deliveries", d.id, {
    ...d,
    attribution: { ...d.attribution, attributionHash: "f".repeat(64) },
  });
  expect(() => readDelivery(d.id)).toThrow(/integrity/);
  expect(() => listDeliveryAttributions()).toThrow(/integrity/);
});

it("stale checkpoint writers cannot replace newer handles", () => {
  const e = entry(),
    d = createDelivery(e);
  saveDeliveryHandles(d, { session: "https://saved/one", uploadOffset: "100" });
  expect(() =>
    saveDeliveryHandles(d, { session: "https://stale/old", uploadOffset: "0" }),
  ).toThrow(/stale/i);
  expect(readDeliveryHandles(readDelivery(d.id)!)).toMatchObject({
    session: "https://saved/one",
    uploadOffset: "100",
  });
});
it("package index corruption is never absence or another delivery", () => {
  const e = entry(),
    a = createDelivery(e),
    b = createDelivery(
      decide({ ...e, text: { title: "second" } }, false, new Date()),
    );
  runtimeStore().put("delivery-identities", a.package.packageHash, {
    id: b.id,
  });
  expect(() => deliveryForPackage(a.package.packageHash)).toThrow(/identity/i);
  runtimeStore().put("delivery-identities", a.package.packageHash, {
    id: "missing",
  });
  expect(() => deliveryForPackage(a.package.packageHash)).toThrow(/identity/i);
});

it("only the exact one-ahead sidecar is adopted after its DB checkpoint fails", () => {
  const e = entry(),
    d = createDelivery(e),
    store = runtimeStore(),
    original = store.put.bind(store);
  store.put = (kind, ...args) => {
    if (kind === "deliveries") throw Error("ack commit failed");
    return original(kind, ...args);
  };
  try {
    expect(() =>
      saveDeliveryHandles(d, { session: "https://accepted/session" }),
    ).toThrow("ack commit failed");
  } finally {
    store.put = original;
  }
  expect(readDelivery(d.id)?.checkpoint).toBe(0);
  expect(readDeliveryHandles(d).session).toBe("https://accepted/session");
  expect(readDelivery(d.id)?.checkpoint).toBe(1);
  const file = path.join(root, "delivery-private", `${d.id}.json`),
    saved = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    JSON.stringify({
      ...saved,
      checkpoint: { ...saved.checkpoint, sequence: 3 },
    }),
  );
  expect(() => readDeliveryHandles(readDelivery(d.id)!)).toThrow(
    /checkpoint identity/,
  );
  writeFileSync(
    file,
    JSON.stringify({
      ...saved,
      checkpoint: { ...saved.checkpoint, generation: 999 },
    }),
  );
  expect(() => readDeliveryHandles(readDelivery(d.id)!)).toThrow(
    /checkpoint identity/,
  );
});
it("first save syncs the new directory parent before writing, then file before rename and child directory after", () => {
  const e = entry(),
    d = createDelivery(e),
    events: string[] = [],
    fds = new Map<number, string>();
  const fs = {
    ...nativeFs,
    openSync: (...args: Parameters<typeof nativeFs.openSync>) => {
      const fd = nativeFs.openSync(...args);
      fds.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      events.push(`sync:${fds.get(fd)}`);
      nativeFs.fsyncSync(fd);
    },
    mkdirSync: ((...args: Parameters<typeof nativeFs.mkdirSync>) => {
      events.push(`mkdir:${args[0]}`);
      return nativeFs.mkdirSync(...args);
    }) as typeof nativeFs.mkdirSync,
    writeFileSync: ((...args: Parameters<typeof nativeFs.writeFileSync>) => {
      events.push("write");
      return nativeFs.writeFileSync(...args);
    }) as typeof nativeFs.writeFileSync,
    renameSync: (a: nativeFs.PathLike, b: nativeFs.PathLike) => {
      events.push("rename");
      nativeFs.renameSync(a, b);
    },
  };
  saveDeliveryHandles(d, { session: "https://saved/session" }, fs);
  const mkdir = events.indexOf(`mkdir:${path.join(root, "delivery-private")}`);
  expect(mkdir).toBeGreaterThanOrEqual(0);
  expect(events[mkdir + 1]).toBe(`sync:${root}`);
  const write = events.indexOf("write"),
    rename = events.indexOf("rename");
  expect(events[write + 1]).toMatch(/sync:.*\.tmp$/);
  expect(rename).toBe(write + 2);
  expect(events[rename + 1]).toBe(
    `sync:${path.join(root, "delivery-private")}`,
  );
});

it("failed rename-directory sync cannot be adopted until durability is retried successfully", () => {
  const d = createDelivery(entry()),
    fds = new Map<number, string>();
  let renamed = false,
    fail = true,
    childSyncs = 0;
  const fs = {
    ...nativeFs,
    openSync: (...args: Parameters<typeof nativeFs.openSync>) => {
      const fd = nativeFs.openSync(...args);
      fds.set(fd, String(args[0]));
      return fd;
    },
    renameSync: (a: nativeFs.PathLike, b: nativeFs.PathLike) => {
      nativeFs.renameSync(a, b);
      renamed = true;
    },
    fsyncSync: (fd: number) => {
      if (renamed && fds.get(fd) === path.join(root, "delivery-private")) {
        childSyncs++;
        if (fail) throw Error("directory sync failed");
      }
      nativeFs.fsyncSync(fd);
    },
  };
  expect(() =>
    saveDeliveryHandles(d, { session: "https://accepted/session" }, fs),
  ).toThrow("directory sync failed");
  expect(readDelivery(d.id)?.checkpoint).toBe(0);
  expect(() => readDeliveryHandles(d, fs)).toThrow("directory sync failed");
  expect(readDelivery(d.id)?.checkpoint).toBe(0);
  fail = false;
  expect(readDeliveryHandles(d, fs).session).toBe("https://accepted/session");
  expect(childSyncs).toBeGreaterThanOrEqual(3);
  expect(readDelivery(d.id)?.checkpoint).toBe(1);
});
it("an existing directory from failed mkdir-parent sync is synced again before saving", () => {
  const d = createDelivery(entry()),
    fds = new Map<number, string>();
  let fail = true,
    rootSyncs = 0;
  const fs = {
    ...nativeFs,
    openSync: (...args: Parameters<typeof nativeFs.openSync>) => {
      const fd = nativeFs.openSync(...args);
      fds.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      if (fds.get(fd) === root) {
        rootSyncs++;
        if (fail) throw Error("parent sync failed");
      }
      nativeFs.fsyncSync(fd);
    },
  };
  expect(() =>
    saveDeliveryHandles(d, { session: "https://saved/session" }, fs),
  ).toThrow("parent sync failed");
  expect(() =>
    saveDeliveryHandles(d, { session: "https://saved/session" }, fs),
  ).toThrow("parent sync failed");
  expect(readDelivery(d.id)?.checkpoint).toBe(0);
  fail = false;
  saveDeliveryHandles(d, { session: "https://saved/session" }, fs);
  expect(rootSyncs).toBeGreaterThanOrEqual(3);
  expect(readDelivery(d.id)?.checkpoint).toBe(1);
});

it("failed temporary checkpoint writes do not accumulate artifacts or remove the accepted checkpoint", () => {
  const d = createDelivery(entry());
  const accepted = saveDeliveryHandles(d, {
    session: "https://fixture/original",
  });
  expect(() =>
    saveDeliveryHandles(
      accepted,
      { offset: "10" },
      {
        ...nativeFs,
        writeFileSync: (() => {
          throw Object.assign(Error("injected disk full"), { code: "ENOSPC" });
        }) as typeof nativeFs.writeFileSync,
      },
    ),
  ).toThrow(/disk full/);
  expect(
    nativeFs
      .readdirSync(path.join(root, "delivery-private"))
      .filter((x) => x.endsWith(".tmp")),
  ).toEqual([]);
  expect(readDeliveryHandles(accepted).session).toBe(
    "https://fixture/original",
  );
});
