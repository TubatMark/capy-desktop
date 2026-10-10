import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openStore, type Store } from "./index";
import { dataDir } from "../settings";
import { validateLegacy } from "./legacy-validation";
const stores = new Map<string, Store>();
export function runtimeStore() {
  const dir = dataDir();
  let store = stores.get(dir);
  if (!store) {
    store = openStore(dir);
    stores.set(dir, store);
  }
  return store;
}
/** One-time legacy fallback; errors remain visible and original files are retained. */
export function legacyState<T>(
  id: string,
  initial: () => T,
  validate: (value: unknown) => boolean,
): T {
  const store = runtimeStore();
  const row = store.get<T>("legacy-state", id);
  if (row) {
    validateLegacy("legacy-state", id, row.value);
    return row.value;
  }
  const file = path.join(dataDir(), `${id}.json`);
  let value = initial();
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    value = JSON.parse(raw) as T;
    validateLegacy("legacy-state", id, value);
    if (!validate(value)) throw Error(`Invalid legacy ${file}`);
    const backup = path.join(dataDir(), "legacy-backups", randomUUID());
    mkdirSync(backup, { recursive: true });
    copyFileSync(file, path.join(backup, `${id}.json`));
    const digest = createHash("sha256").update(raw).digest("hex");
    store.transaction(() => {
      if (store.get("legacy-state", id)) return;
      store.put("legacy-state", id, value);
      store.db
        .prepare(
          "INSERT OR IGNORE INTO imports(source,digest,imported_at) VALUES(?,?,?)",
        )
        .run(file, digest, Date.now());
      store.put("import-history", file, {
        source: file,
        digest,
        backupLocation: backup,
        completedAt: Date.now(),
      });
    });
  }
  return store.transaction(() => {
    const existing = store.get<T>("legacy-state", id);
    if (existing) return existing.value;
    store.put("legacy-state", id, value);
    return value;
  });
}
export function mutateLegacy<T>(
  id: string,
  initial: () => T,
  validate: (value: unknown) => boolean,
  fn: (value: T) => T,
): T {
  legacyState(id, initial, validate);
  return runtimeStore().mutate("legacy-state", id, initial, fn);
}
