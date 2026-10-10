import { randomUUID } from "node:crypto";
import * as nativeFs from "node:fs";
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
import { fence, currentWork } from "./worker/context";
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
        generation: currentWork()?.lease.generation ?? 0,
        checkpoint: 0,
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
export function readDelivery(id: string, store = runtimeStore()): DeliveryRecord | undefined {
  const row = store.get("deliveries", id);
  if (!row) return;
  const d = DeliveryRecordSchema.parse(row.value);
  const { packageHash, ...manifest } = d.package;
  const attribution = getPublicationAttribution(packageHash, store);
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
        generation: currentWork()?.lease.generation ?? old.generation,
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
export function deliveryForPackage(packageHash: string, store = runtimeStore()) {
  const ref = store.get<{ id: string }>(
    "delivery-identities",
    packageHash,
  );
  if (!ref) return;
  const found = readDelivery(ref.value.id, store);
  if (!found || found.package.packageHash !== packageHash)
    throw Error("Delivery identity index is missing or mismatched");
  return found;
}
const CheckpointIdentity = z.strictObject({
  sequence: z.number().int().positive(),
  operationId: z.string(),
  intentRevision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
});
const Handles = z.strictObject({
  version: z.literal(1),
  deliveryId: z.string().uuid(),
  packageHash: z.string(),
  accountId: z.string(),
  checkpoint: CheckpointIdentity,
  values: z.record(z.string().max(100), z.string().max(8192)),
});
type DeliveryFs = Pick<
  typeof nativeFs,
  | "lstatSync"
  | "mkdirSync"
  | "chmodSync"
  | "openSync"
  | "closeSync"
  | "fsyncSync"
  | "readFileSync"
  | "writeFileSync"
  | "renameSync"
  | "unlinkSync"
>;
function syncDirectory(dir: string, fs: DeliveryFs) {
  const fd = fs.openSync(dir, nativeFs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** Every newly created ancestor is linked durably before the next child is created. */
function durableDirectory(dir: string, fs: DeliveryFs) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Unsafe delivery directory");
    // A previous mkdir may have succeeded while its parent sync failed.
    syncDirectory(path.dirname(dir), fs);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const parent = path.dirname(dir);
  if (parent === dir) throw Error("Missing filesystem root");
  durableDirectory(parent, fs);
  fs.mkdirSync(dir, { mode: 0o700 });
  syncDirectory(parent, fs);
}
function privateFile(id: string, fs: DeliveryFs) {
  z.string().uuid().parse(id);
  const dir = path.join(dataDir(), "delivery-private");
  durableDirectory(dir, fs);
  fs.chmodSync(dir, 0o700);
  return { dir, file: path.join(dir, `${id}.json`) };
}
function rawHandles(d: DeliveryRecord, fs: DeliveryFs) {
  const { file } = privateFile(d.id, fs);
  let raw: string;
  try {
    const fd = fs.openSync(
      file,
      nativeFs.constants.O_RDONLY | nativeFs.constants.O_NOFOLLOW,
    );
    try {
      raw = fs.readFileSync(fd, "utf8") as string;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const value = Handles.parse(JSON.parse(raw));
  if (
    value.deliveryId !== d.id ||
    value.packageHash !== d.package.packageHash ||
    value.accountId !== d.package.accountId
  )
    throw Error("Delivery handle identity mismatch");
  return value;
}
function validateHandleCheckpoint(
  d: DeliveryRecord,
  v: z.infer<typeof Handles>,
) {
  const c = v.checkpoint;
  const accepted =
    c.sequence === d.checkpoint &&
    JSON.stringify(c) === JSON.stringify(d.handleCheckpoint);
  const ahead =
    c.sequence === d.checkpoint + 1 &&
    c.intentRevision === d.revision &&
    c.generation === d.generation &&
    c.operationId === `${d.id}:${d.revision}:${d.phase}`;
  if (!accepted && !ahead)
    throw Error("Delivery handle checkpoint identity mismatch");
  return ahead;
}
/** Adopt only the one acknowledgement whose exact durable intent survived a failed DB commit. */
export function readDeliveryHandles(
  d: DeliveryRecord,
  fs: DeliveryFs = nativeFs,
): Record<string, string> {
  return fence(() =>
    runtimeStore().transaction(() => {
      const current = readDelivery(d.id);
      if (
        !current ||
        current.package.packageHash !== d.package.packageHash ||
        current.package.accountId !== d.package.accountId
      )
        throw Error("Delivery handle identity mismatch");
      const v = rawHandles(current, fs);
      if (!v) return {};
      if (validateHandleCheckpoint(current, v)) {
        // A matching sidecar may exist because rename succeeded but fsync failed.
        // Re-establish every durability barrier before accepting its acknowledgement.
        const { file, dir } = privateFile(current.id, fs);
        const fd = fs.openSync(
          file,
          nativeFs.constants.O_RDONLY | nativeFs.constants.O_NOFOLLOW,
        );
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        syncDirectory(dir, fs);
        updateDelivery(current.id, (x) => ({
          ...x,
          checkpoint: v.checkpoint.sequence,
          handleCheckpoint: v.checkpoint,
        }));
      }
      return v.values;
    }),
  );
}
export function saveDeliveryHandles(
  d: DeliveryRecord,
  values: Record<string, string>,
  fs: DeliveryFs = nativeFs,
): DeliveryRecord {
  return fence(() =>
    runtimeStore().transaction(() => {
      const current = readDelivery(d.id);
      if (
        !current ||
        current.revision !== d.revision ||
        current.generation !== d.generation ||
        current.package.packageHash !== d.package.packageHash ||
        current.package.accountId !== d.package.accountId
      )
        throw Error("Stale delivery checkpoint writer or identity mismatch");
      const prior = rawHandles(current, fs);
      if (prior && validateHandleCheckpoint(current, prior))
        throw Error(
          "Recover the uncommitted delivery checkpoint before writing",
        );
      const checkpoint = {
        sequence: current.checkpoint + 1,
        operationId: `${current.id}:${current.revision}:${current.phase}`,
        intentRevision: current.revision,
        generation: current.generation,
      };
      const v = Handles.parse({
        version: 1,
        deliveryId: d.id,
        packageHash: d.package.packageHash,
        accountId: d.package.accountId,
        checkpoint,
        values: { ...prior?.values, ...values },
      });
      const { dir, file } = privateFile(d.id, fs),
        tmp = path.join(dir, `${d.id}.${randomUUID()}.tmp`);
      const fd = fs.openSync(
        tmp,
        nativeFs.constants.O_WRONLY |
          nativeFs.constants.O_CREAT |
          nativeFs.constants.O_EXCL |
          nativeFs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        try {
          fs.writeFileSync(fd, JSON.stringify(v));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
      } catch (error) {
        // Only this attempt's exclusively created temporary file is disposable.
        // A renamed checkpoint is retained for the durable adoption path.
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* preserve the original storage failure */
        }
        throw error;
      }
      syncDirectory(dir, fs);
      return updateDelivery(d.id, (x) => ({
        ...x,
        checkpoint: checkpoint.sequence,
        handleCheckpoint: checkpoint,
      }));
    }),
  );
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
