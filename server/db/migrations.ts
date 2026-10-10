import type { DatabaseSync } from "node:sqlite";
export const SCHEMA_VERSION = 1;
export function migrate(db: DatabaseSync) {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (version > SCHEMA_VERSION)
    throw Error(`Unsupported storage schema ${version}`);
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(kind,id)) STRICT;
    CREATE TABLE IF NOT EXISTS identities (kind TEXT NOT NULL,key TEXT NOT NULL,document_id TEXT NOT NULL,PRIMARY KEY(kind,key)) STRICT;
    CREATE TABLE IF NOT EXISTS imports (source TEXT PRIMARY KEY,digest TEXT NOT NULL,imported_at INTEGER NOT NULL) STRICT;
    PRAGMA user_version=1; COMMIT;`);
}
