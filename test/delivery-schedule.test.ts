import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicationFixture } from "./publication-fixtures";
import {
  queue,
  upsertForRender,
  move,
  postNow,
  publicQueueEntry,
} from "../server/queue";
import { decide, eligibility } from "../server/publication-policy";
import { approveRemoteSchedule } from "../server/delivery-schedule";
import { runtimeStore } from "../server/db/runtime";
import { loadAccounts } from "../server/accounts";
import { destinationClientIdentity } from "../server/platform-capabilities";
import { createDelivery, saveDeliveryHandles } from "../server/delivery-store";
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "capy-schedule-"));
  process.env.CAPY_DATA_DIR = root;
  const { file } = publicationFixture();
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
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const input = () => ({
  publishAt: Date.now() + 3600000,
  uploadAheadMinutes: 30,
  acknowledgeRemoteSchedule: true as const,
});
function verify() {
  runtimeStore().put("destination-capabilities", "youtube:fixture-account", {
    accountId: "fixture-account",
    clientIdentity: destinationClientIdentity(
      "youtube",
      loadAccounts().youtube,
    ),
    checkedAt: Date.now(),
    schedulingVerified: true,
  });
}
it("requires positive scheduling evidence and explicit acknowledgement", () => {
  const e = queue().list()[0]!;
  expect(() => approveRemoteSchedule(e.key, input())).toThrow(
    /not been verified/,
  );
  expect(queue().list()[0]!.publishPackage).toEqual(e.publishPackage);
  verify();
  expect(() =>
    approveRemoteSchedule(e.key, {
      ...input(),
      acknowledgeRemoteSchedule: false,
    } as never),
  ).toThrow();
});
it("hashes the exact remote time and policy without converting the old approval", () => {
  verify();
  const old = queue().list()[0]!,
    opts = input();
  const next = approveRemoteSchedule(old.key, opts);
  expect(old.publishPackage!.deliveryOptions.mode).toBe("public");
  expect(next.publishPackage!.packageHash).not.toBe(
    old.publishPackage!.packageHash,
  );
  expect(next.publishPackage!.deliveryOptions).toMatchObject({
    mode: "scheduled",
    publishAt: opts.publishAt,
    uploadAheadMinutes: 30,
  });
  const current = queue().list()[0]!;
  expect(eligibility(current).allowed).toBe(true);
  expect(eligibility({ ...current, slotAt: opts.publishAt + 1 }).allowed).toBe(
    false,
  );
  expect(() =>
    move([current], current.key, opts.publishAt + 1, new Date(), "UTC"),
  ).toThrow(/explicit/);
  expect(() => postNow([current], current.key, new Date())).toThrow(/explicit/);
});
it("refuses local changes once session intent exists and strips private progress", () => {
  const e = queue().list()[0]!,
    d = createDelivery(e);
  saveDeliveryHandles(d, {
    deliveryPhase: "session-create-intent",
    session: "https://private.example/secret",
  });
  expect(() => approveRemoteSchedule(e.key, input())).toThrow(
    /already started/,
  );
  expect(() => postNow([e], e.key, new Date())).toThrow(/already started/);
  expect(
    JSON.stringify(publicQueueEntry({ ...e, progress: { session: "secret" } })),
  ).not.toContain("secret");
  expect(JSON.stringify(publicQueueEntry(e))).not.toContain(root);
});
