import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  constants,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { QueueEntry } from "../lib/types";
import {
  DeliveryRecordSchema,
  type DeliveryRecord,
  type DeliveryAttributionProjection,
} from "../lib/delivery";
import { runtimeStore } from "./db/runtime";
import { dataDir } from "./settings";
import { eligibility, packageDigest } from "./publication-policy";
import {
  capturePublicationAttribution,
  getPublicationAttribution,
} from "./publication-attribution";
import { fence } from "./worker/context";
/** Creation never starts a remote request. Caller must revalidate again before each mutation. */
export function createDelivery(entry: QueueEntry): DeliveryRecord {
  return fence(() =>
    runtimeStore().transaction(() => {
      const gate = eligibility(entry);
      if (!gate.allowed) throw Error(gate.reasons.join("; "));
      const pkg = entry.publishPackage!;
      const prior = runtimeStore().get<{ id: string }>(
        "delivery-identities",
        pkg.packageHash,
      );
      if (prior) {
        const found = readDelivery(prior.value.id);
        if (!found || found.package.packageHash !== pkg.packageHash)
          throw Error("Delivery identity integrity failure");
        return found;
      }
      const attribution = capturePublicationAttribution(entry, pkg),
        now = Date.now();
      const record = DeliveryRecordSchema.parse({
        version: 1,
        id: randomUUID(),
        revision: 0,
        queueKey: entry.key,
        package: pkg,
        attribution: {
          packageHash: pkg.packageHash,
          attributionHash: attribution.attributionHash,
        },
        state: "queued",
        phase: "not-started",
        visibility: "unknown",
        publicationIds: [],
        thumbnail: {
          status: pkg.thumbnail ? "pending" : "not-requested",
          checksum: pkg.thumbnail?.checksum,
        },
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      runtimeStore().put("deliveries", record.id, record);
      runtimeStore().put("delivery-identities", pkg.packageHash, {
        id: record.id,
      });
      return record;
    }),
  );
}
export function readDelivery(id: string): DeliveryRecord | undefined {
  const row = runtimeStore().get("deliveries", id);
  if (!row) return;
  const d = DeliveryRecordSchema.parse(row.value);
  const { packageHash, ...manifest } = d.package;
  const attribution = getPublicationAttribution(packageHash);
  if (
    d.id !== id ||
    packageDigest(manifest) !== packageHash ||
    d.attribution.packageHash !== packageHash ||
    attribution?.attributionHash !== d.attribution.attributionHash
  )
    throw Error("Delivery identity or attribution integrity mismatch");
  return d;
}
export function updateDelivery(
  id: string,
  change: (d: DeliveryRecord) => DeliveryRecord,
): DeliveryRecord {
  return fence(() =>
    runtimeStore().transaction(() => {
      const old = readDelivery(id);
      if (!old) throw Error("Delivery not found");
      const next = DeliveryRecordSchema.parse({
        ...change(structuredClone(old)),
        revision: old.revision + 1,
        updatedAt: Date.now(),
      });
      if (
        next.id !== old.id ||
        JSON.stringify(next.package) !== JSON.stringify(old.package) ||
        JSON.stringify(next.attribution) !== JSON.stringify(old.attribution)
      )
        throw Error("Immutable delivery identity changed");
      runtimeStore().put("deliveries", id, next, next.revision);
      return next;
    }),
  );
}
export function deliveryForPackage(packageHash: string) {
  const ref = runtimeStore().get<{ id: string }>(
    "delivery-identities",
    packageHash,
  );
  return ref ? readDelivery(ref.value.id) : undefined;
}
const Handles = z.strictObject({
  version: z.literal(1),
  deliveryId: z.string().uuid(),
  packageHash: z.string(),
  accountId: z.string(),
  values: z.record(z.string().max(100), z.string().max(8192)),
});
function privateFile(id: string) {
  z.string().uuid().parse(id);
  const dir = path.join(dataDir(), "delivery-private");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw Error("Unsafe delivery directory");
  chmodSync(dir, 0o700);
  return { dir, file: path.join(dir, `${id}.json`) };
}
export function readDeliveryHandles(d: DeliveryRecord): Record<string, string> {
  const { file } = privateFile(d.id);
  let raw: string;
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const v = Handles.parse(JSON.parse(raw));
  if (
    v.deliveryId !== d.id ||
    v.packageHash !== d.package.packageHash ||
    v.accountId !== d.package.accountId
  )
    throw Error("Delivery handle identity mismatch");
  return v.values;
}
export function saveDeliveryHandles(
  d: DeliveryRecord,
  values: Record<string, string>,
): void {
  fence(() => {
    const { dir, file } = privateFile(d.id),
      tmp = path.join(dir, `${d.id}.${randomUUID()}.tmp`);
    const v = Handles.parse({
      version: 1,
      deliveryId: d.id,
      packageHash: d.package.packageHash,
      accountId: d.package.accountId,
      values: { ...readDeliveryHandles(d), ...values },
    });
    const fd = openSync(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(v));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    const parent = openSync(dir, constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  });
}
export function deliveryProjection(
  d: DeliveryRecord,
): DeliveryAttributionProjection {
  return {
    id: d.id,
    revision: d.revision,
    packageId: d.package.id,
    packageHash: d.package.packageHash,
    attribution: d.attribution,
    platform: d.package.platform,
    accountId: d.package.accountId,
    artifact: d.package.artifact,
    selectedThumbnail: d.package.thumbnail,
    thumbnail: d.thumbnail,
    state: d.state,
    visibility: d.visibility,
    publicationIds: d.publicationIds,
    remoteStatus: d.remoteStatus,
    observedAt: d.observedAt,
    firstPublicAt: d.firstPublicAt,
    publishedAt: d.publishedAt,
    nextTryAt: d.nextTryAt,
    retryClass: d.retryClass,
    reason: d.reason,
  };
}
export function listDeliveryAttributions(
  accountId?: string,
): DeliveryAttributionProjection[] {
  return runtimeStore()
    .list("deliveries")
    .map((r) => readDelivery(r.id)!)
    .filter((d) => !accountId || d.package.accountId === accountId)
    .map(deliveryProjection);
}
