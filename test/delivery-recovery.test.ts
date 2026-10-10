import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicationFixture } from "./publication-fixtures";
import { decide } from "../server/publication-policy";
import { upsertForRender } from "../server/queue";
import { runtimeStore } from "../server/db/runtime";
import { capturePublicationAttribution } from "../server/publication-attribution";
import {
  createDelivery,
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
