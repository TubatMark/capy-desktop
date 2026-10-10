/** Only launched by the isolated soak runner. No production registration. */
import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { strict as assert } from "node:assert";
const [root, slot, origin, token, operation] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
assert(
  root && slot && origin && token && process.send,
  "Fixture IPC launch required",
);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
assert(path.basename(path.dirname(root)).startsWith("capy-isolated-soak-"));
assert(
  fs.existsSync(path.join(path.dirname(root), ".capy-isolated-soak.json")),
);
assert(process.env.CAPY_DATA_DIR === root);
// Defense in depth: even an accidental non-injected HTTP client cannot leave loopback.
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  const options = a[0];
  const host =
    typeof options === "object" && options !== null
      ? (options as { host?: string }).host
      : a[1];
  assert(host === "127.0.0.1", "Non-loopback socket blocked by soak fixture");
  return Reflect.apply(originalConnect, this, args);
} as typeof Socket.prototype.connect;
process.on("disconnect", () => process.exit(1));
process.channel?.unref(); // A dead runner cannot leave an orphan fixture executor.
assert.throws(
  () => new Socket().connect({ host: "203.0.113.1", port: 443 }),
  /Non-loopback/,
);
const denyNetwork = () => {
  throw Error("Non-loopback DNS/UDP blocked by soak fixture");
};
dgram.createSocket = denyNetwork;
for (const target of [
  dns,
  dnsPromises,
  dns.Resolver.prototype,
  dnsPromises.Resolver.prototype,
]) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (/^(resolve|reverse|lookup)/.test(key))
      Reflect.set(target, key, denyNetwork);
  }
}
syncBuiltinESMExports();
assert.throws(() => dgram.createSocket("udp4"), /Non-loopback/);
assert.throws(() => dns.resolve("fixture.invalid", () => {}), /Non-loopback/);
assert.equal(
  process.env.ANTHROPIC_API_KEY,
  undefined,
  "Inherited provider credential",
);
const localFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error("Uninjected network blocked by soak fixture");
};
const { publicationFixture } = await import("../publication-fixtures");
const { decide } = await import("../../server/publication-policy");
const { queue, upsertForRender, retry } = await import("../../server/queue");
const { runtimeStore } = await import("../../server/db/runtime");
const { WorkQueue } = await import("../../server/worker/leases");
const { withWork } = await import("../../server/worker/context");
const { deliverPackage, reconcileDelivery } =
  await import("../../server/delivery");
const {
  createDelivery,
  deliveryForPackage,
  readDelivery,
  updateDelivery,
  saveDeliveryHandles,
  readDeliveryHandles,
} = await import("../../server/delivery-store");
const { AuthError } = await import("../../server/accounts");
const file = path.join(root, "fixture.mp4");
const digest = () =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (!queue().list().length) {
  assert(!fs.existsSync(file), "Orphaned artifact needs investigation");
  const files = publicationFixture();
  const e = {
    ...decide(
      upsertForRender(
        [],
        {
          publicationFiles: files,
          jobId: "isolated-soak",
          n: 1,
          start: 0,
          end: 30,
          clipTitle: slot,
          videoUrl: "/fixture",
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
  fs.writeFileSync(path.join(root, "artifact.sha256"), digest(), {
    flag: "wx",
    mode: 0o600,
  });
}
assert.equal(
  digest(),
  fs.readFileSync(path.join(root, "artifact.sha256"), "utf8"),
  "Completed artifact lost/changed",
);
const entry = queue().list()[0]!;
const q = new WorkQueue(runtimeStore(), { leaseMs: 1500 });
// Fixed single job per slot. A completed fixture job is explicitly made retryable;
// delivery/package identity and remote evidence are never removed or reset.
const old = q.list()[0];
if (!old)
  await q.enqueue({
    kind: "fixture-soak",
    workKey: "fixture-soak",
    inputRevision: 1,
    payload: {},
  });
else if (old.status === "complete")
  runtimeStore().put("work", old.id, { ...old, status: "retryable" });
let lease = await q.claim(token);
const deadline = Date.now() + 5000;
while (!lease && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
  lease = await q.claim(token);
}
assert(lease, "No fixture lease available");
process.send!({
  kind: "ready",
  pid: process.pid,
  token,
  generation: lease.generation,
});
let hb: ReturnType<typeof setInterval> | undefined = setInterval(() => {
  try {
    q.heartbeat(lease!);
  } catch {}
}, 200);
let staleWritesRejected = 0;
let authRetries = 0;
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  assert(
    url.protocol === "https:" &&
      ["www.googleapis.com", "fixture.invalid"].includes(url.hostname),
    "Unexpected fixture destination",
  );
  const destination = new URL(origin + "/" + slot + url.pathname + url.search);
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  headers.set("x-fixture-token", token);
  headers.set("x-fixture-operation", operation);
  return localFetch(destination, { ...init, headers, redirect: "error" });
};
try {
  await withWork(
    { queue: q, lease, workspace: root, signal: new AbortController().signal },
    async () => {
      if (operation === "fault" && slot === "lease") {
        clearInterval(hb);
        hb = undefined;
        await new Promise((r) => setTimeout(r, 1600));
        const replacement = await q.claim(token + "-replacement");
        assert(replacement);
        assert.throws(() => q.checkpoint(lease!, "illegal", {}), /lease/i);
        staleWritesRejected++;
        assert.throws(() => createDelivery(entry), /lease/i);
        staleWritesRejected++;
        q.finish(replacement, "complete");
        return;
      }
      if (operation === "fault" && ["enospc", "fsync"].includes(slot)) {
        const d =
          deliveryForPackage(entry.publishPackage!.packageHash) ??
          createDelivery(entry);
        const failing = {
          ...fs,
          ...(slot === "enospc"
            ? {
                writeFileSync: () => {
                  throw Object.assign(Error("fixture ENOSPC"), {
                    code: "ENOSPC",
                  });
                },
              }
            : {
                fsyncSync: () => {
                  throw Error("fixture fsync failure");
                },
              }),
        } as typeof fs;
        assert.throws(
          () =>
            saveDeliveryHandles(d, { fixtureDiskProbe: "attempt" }, failing),
          /ENOSPC|fsync/,
        );
        assert.equal(readDelivery(d.id)!.checkpoint, d.checkpoint);
        readDeliveryHandles(readDelivery(d.id)!); // Re-read durable evidence, never erase it.
      }
      // The fault is an auth pause, not automatic publication authorization.
      // Model the explicit fixture user retry through the production queue action.
      const beforeRecovery = deliveryForPackage(
        entry.publishPackage!.packageHash,
      );
      if (
        operation === "recover" &&
        slot === "auth" &&
        beforeRecovery?.phase === "destination-pinned"
      ) {
        assert.equal(beforeRecovery.state, "needs-action");
        assert.equal(beforeRecovery.retryClass, "auth");
        const current = queue().list()[0]!;
        assert.equal(current.status, "needs_action");
        assert.equal(current.authBlocked, true);
        const handles = readDeliveryHandles(beforeRecovery);
        assert(
          !handles.session &&
            !handles.videoId &&
            !handles.container &&
            !handles.publishId &&
            !handles.deliveryPhase,
          "Cannot retry an attempted remote mutation",
        );
        runtimeStore().transaction(() => {
          updateDelivery(beforeRecovery.id, (d) => ({
            ...d,
            state: "queued",
            nextTryAt: Date.now(),
            reason: undefined,
            retryClass: undefined,
          }));
          queue().mutate((all) => retry(all, entry.key, new Date()));
          const retried = queue().list()[0]!;
          assert.equal(retried.status, "scheduled");
          assert.equal(
            retried.publishPackage!.packageHash,
            entry.publishPackage!.packageHash,
          );
          assert.equal(
            deliveryForPackage(retried.publishPackage!.packageHash)!.id,
            beforeRecovery.id,
          );
        });
        authRetries++;
      }
      const deps = {
        fetch: fetcher,
        token: async () => {
          if (operation === "fault" && slot === "auth")
            throw new AuthError("fixture revoked token");
          return "isolated-fixture-token";
        },
      };
      const d = deliveryForPackage(entry.publishPackage!.packageHash);
      const state =
        d &&
        ![
          "not-started",
          "destination-pinned",
          "initialization-rejected",
          "session-known",
        ].includes(d.phase)
          ? await reconcileDelivery(d.id, deps)
          : await deliverPackage(
              entry.publishPackage!.id,
              new AbortController().signal,
              deps,
            );
      if (operation === "fault" && slot === "auth")
        assert.equal(state, "needs-action");
      const saved = deliveryForPackage(entry.publishPackage!.packageHash)!;
      if (slot === "unknown-session") {
        assert.equal(saved.state, "delivery-unknown");
        if (operation === "recover") assert.equal(saved.nextTryAt, undefined);
      }
      assert.equal(runtimeStore().list("deliveries").length, 1);
      assert.equal(runtimeStore().list("delivery-identities").length, 1);
      assert.equal(runtimeStore().list("work").length, 1);
      q.finish(lease!, "complete");
    },
  );
  const d = deliveryForPackage(entry.publishPackage!.packageHash);
  assert.equal(
    digest(),
    fs.readFileSync(path.join(root, "artifact.sha256"), "utf8"),
  );
  runtimeStore().db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  process.send!({
    kind: "result",
    token,
    state: d?.state ?? "queued",
    claims: runtimeStore().list("delivery-identities").length,
    deliveries: runtimeStore().list("deliveries").length,
    artifact: digest(),
    deliveryId: d?.id,
    packageHash: entry.publishPackage!.packageHash,
    staleWritesRejected,
    authRetries,
    generation: lease.generation,
  });
} finally {
  clearInterval(hb);
  runtimeStore().db.close();
}
