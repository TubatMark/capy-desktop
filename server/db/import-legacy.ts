import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./index";
import { validateLegacy } from "./legacy-validation";
export interface LegacyImportInput {
  store: Store;
  dataDir: string;
  outputRoot: string;
  beforeCommit?: () => void;
}
export interface ImportReport {
  imported: string[];
  skipped: string[];
  unresolved: { id: string; location: string }[];
  corrupt: { file: string; error: string }[];
  backupLocation: string | null;
  diagnostics: {
    file: string;
    status: "changed-recovery" | "corrupt-recovery" | "missing-recovery";
    originalDigest: string;
    observedDigest?: string;
    error?: string;
  }[];
}
/** Validate and back up every legacy source before a single transactional activation. Originals are never modified. */
export async function importLegacy(
  input: LegacyImportInput,
): Promise<ImportReport> {
  const { store, dataDir, outputRoot } = input;
  let backupLocation: string | null = null;
  const report: ImportReport = {
    imported: [],
    skipped: [],
    unresolved: [],
    corrupt: [],
    backupLocation,
    diagnostics: [],
  };
  const files: { file: string; kind: string; id: string }[] = [
    {
      file: path.join(dataDir, "watch.json"),
      kind: "legacy-state",
      id: "watch",
    },
    {
      file: path.join(dataDir, "queue.json"),
      kind: "legacy-state",
      id: "queue",
    },
  ];
  if (existsSync(outputRoot))
    for (const dir of readdirSync(outputRoot, { withFileTypes: true }))
      if (dir.isDirectory())
        files.push({
          file: path.join(outputRoot, dir.name, "job.json"),
          kind: "legacy-jobs",
          id: dir.name,
        });
  const records: {
    file: string;
    kind: string;
    id: string;
    body: any;
    digest: string;
  }[] = [];
  // Completed markers are consulted first: recovery material cannot disable healthy durable state.
  const completed = store.db
    .prepare("SELECT source,digest FROM imports")
    .all() as { source: string; digest: string }[];
  for (const prior of completed)
    if (!files.some((entry) => entry.file === prior.source))
      files.push({ file: prior.source, kind: "recovery", id: prior.source });
  const pending: typeof files = [];
  for (const entry of files) {
    const prior = completed.find((marker) => marker.source === entry.file);
    if (prior) {
      report.skipped.push(entry.id);
      if (!existsSync(entry.file)) {
        report.diagnostics.push({
          file: entry.file,
          status: "missing-recovery",
          originalDigest: prior.digest,
        });
        continue;
      }
      let raw: Buffer;
      try {
        raw = readFileSync(entry.file);
      } catch (error) {
        report.diagnostics.push({
          file: entry.file,
          status: "corrupt-recovery",
          originalDigest: prior.digest,
          error: String(error),
        });
        continue;
      }
      const observedDigest = createHash("sha256").update(raw).digest("hex");
      if (observedDigest !== prior.digest) {
        let status: "changed-recovery" | "corrupt-recovery" =
          "changed-recovery";
        let error: string | undefined;
        try {
          const body = JSON.parse(raw.toString());
          if (entry.kind !== "recovery")
            validateLegacy(
              entry.kind,
              entry.id,
              body,
              entry.kind === "legacy-jobs"
                ? path.basename(path.dirname(entry.file))
                : undefined,
            );
        } catch (e) {
          status = "corrupt-recovery";
          error = String(e);
        }
        report.diagnostics.push({
          file: entry.file,
          status,
          originalDigest: prior.digest,
          observedDigest,
          error,
        });
      }
      continue;
    }
    if (existsSync(entry.file)) pending.push(entry);
  }
  for (const diagnostic of report.diagnostics) {
    const identity = JSON.stringify([
      diagnostic.file,
      diagnostic.observedDigest ?? "missing",
      diagnostic.status,
    ]);
    if (!store.get("import-diagnostics", identity))
      store.put("import-diagnostics", identity, {
        ...diagnostic,
        observedAt: Date.now(),
      });
  }
  if (!pending.length) return report;
  backupLocation = path.join(dataDir, "legacy-backups", randomUUID());
  report.backupLocation = backupLocation;
  mkdirSync(backupLocation, { recursive: true });
  for (const [index, entry] of pending.entries()) {
    const raw = readFileSync(entry.file);
    copyFileSync(
      entry.file,
      path.join(
        backupLocation,
        `${index}-${path.basename(path.dirname(entry.file))}-${path.basename(entry.file)}`,
      ),
    );
    try {
      const body = JSON.parse(raw.toString());
      validateLegacy(
        entry.kind,
        entry.id,
        body,
        entry.kind === "legacy-jobs"
          ? path.basename(path.dirname(entry.file))
          : undefined,
      );
      records.push({
        ...entry,
        id: entry.kind === "legacy-jobs" ? body.id : entry.id,
        body,
        digest: createHash("sha256").update(raw).digest("hex"),
      });
    } catch (error) {
      report.corrupt.push({ file: entry.file, error: String(error) });
    }
  }
  if (report.corrupt.length) {
    writeFileSync(
      path.join(backupLocation, "report.json"),
      JSON.stringify(report, null, 2),
    );
    throw Object.assign(
      Error(
        `Legacy import blocked by corrupt records: ${report.corrupt.map((c) => c.file).join(", ")}`,
      ),
      { report },
    );
  }
  store.backup(path.join(backupLocation, "before.sqlite"));
  store.transaction(() => {
    for (const r of records) {
      const prior = store.db
        .prepare("SELECT digest FROM imports WHERE source=?")
        .get(r.file) as { digest: string } | undefined;
      if (prior) {
        report.skipped.push(r.id);
        continue;
      }
      if (store.get(r.kind, r.id)) {
        report.skipped.push(r.id);
      } else {
        store.put(r.kind, r.id, r.body);
        report.imported.push(r.id);
        if (r.kind === "legacy-jobs")
          for (const clip of r.body.clips) {
            const original = clip.render?.file;
            if (typeof original !== "string") continue;
            const local = path.join(
              path.dirname(r.file),
              path.basename(original),
            );
            const location = existsSync(original) ? original : local;
            const id = `${r.id}:clip:${clip.n}`;
            const ready = existsSync(location);
            store.put("assets", id, {
              id,
              kind: "video",
              location,
              originalLocation: original,
              status: ready ? "waiting" : "missing",
              checksum: "",
              name: path.basename(original),
              legacy: true,
            });
            if (!ready) report.unresolved.push({ id, location: original });
          }
      }
      store.put("import-history", r.file, {
        source: r.file,
        digest: r.digest,
        backupLocation,
        completedAt: Date.now(),
      });
      store.db
        .prepare("INSERT INTO imports(source,digest,imported_at) VALUES(?,?,?)")
        .run(r.file, r.digest, Date.now());
    }
    input.beforeCommit?.();
  });
  if (store.integrity() !== "ok") throw Error("Import integrity failed");
  writeFileSync(
    path.join(backupLocation, "report.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
