import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrations";
export class RevisionConflict extends Error {
  constructor(
    public expected: number,
    public actual: number | undefined,
  ) {
    super(
      `revision conflict: expected ${expected}, actual ${actual ?? "missing"}`,
    );
  }
}
export interface Stored<T = unknown> {
  id: string;
  revision: number;
  value: T;
}
export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;",
    );
    const mode = this.db.prepare("PRAGMA journal_mode=WAL").get() as {
      journal_mode: string;
    };
    if (mode.journal_mode !== "wal") throw Error("WAL unavailable");
    migrate(this.db);
  }
  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === "AsyncFunction")
      throw Error("Transactions must be synchronous");
    const entryDepth = this.depth;
    const name = `nested_${entryDepth}`;
    this.db.exec(entryDepth ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    this.depth = entryDepth + 1;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw Error("Transactions must be synchronous");
      }
      this.db.exec(entryDepth ? `RELEASE ${name}` : "COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec(
          entryDepth ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK",
        );
      } catch (rollbackError) {
        // Preserve the operation's original error; attach rollback evidence for diagnosis.
        if (error instanceof Error) Object.assign(error, { rollbackError });
      }
      throw error;
    } finally {
      this.depth = entryDepth;
    }
  }
  get<T = unknown>(kind: string, id: string): Stored<T> | undefined {
    const r = this.db
      .prepare("SELECT revision,body FROM documents WHERE kind=? AND id=?")
      .get(kind, id) as { revision: number; body: string } | undefined;
    return r
      ? { id, revision: r.revision, value: JSON.parse(r.body) as T }
      : undefined;
  }
  list<T = unknown>(kind: string): Stored<T>[] {
    return (
      this.db
        .prepare(
          "SELECT id,revision,body FROM documents WHERE kind=? ORDER BY id",
        )
        .all(kind) as { id: string; revision: number; body: string }[]
    ).map((r) => ({
      id: r.id,
      revision: r.revision,
      value: JSON.parse(r.body) as T,
    }));
  }
  put(kind: string, id: string, value: unknown, revision = 0) {
    this.db
      .prepare(
        "INSERT INTO documents(kind,id,revision,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,body=excluded.body",
      )
      .run(kind, id, revision, JSON.stringify(value));
  }
  save<T>(kind: string, id: string, value: T, expected: number): Stored<T> {
    return this.transaction(() => {
      const old = this.get(kind, id);
      if (old?.revision !== expected && !(old === undefined && expected === 0))
        throw new RevisionConflict(expected, old?.revision);
      const revision = expected + 1;
      this.put(kind, id, value, revision);
      return { id, revision, value };
    });
  }
  mutate<T>(
    kind: string,
    id: string,
    initial: () => T,
    fn: (value: T) => T,
  ): T {
    return this.transaction(() => {
      const old = this.get<T>(kind, id);
      const value = fn(old?.value ?? initial());
      this.put(kind, id, value, (old?.revision ?? 0) + 1);
      return value;
    });
  }
  claim(kind: string, key: string, documentId: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO identities(kind,key,document_id) VALUES(?,?,?)",
          )
          .run(kind, key, documentId).changes,
      ) === 1
    );
  }
  backup(destination: string) {
    this.db.prepare("VACUUM INTO ?").run(destination);
    const check = new DatabaseSync(destination);
    try {
      const r = check.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (r.integrity_check !== "ok") throw Error("Backup integrity failed");
    } finally {
      check.close();
    }
  }
  integrity(): string {
    return (
      this.db.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      }
    ).integrity_check;
  }
  close() {
    this.db.close();
  }
}
export function openStore(dataDir: string): Store {
  return new Store(path.join(dataDir, "capy.sqlite"));
}
