// Runs under the actual server executable, without reading existing app data.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const file = path.join(
  mkdtempSync(path.join(tmpdir(), "capy storage probe ")),
  "durable.sqlite",
);
let db = new DatabaseSync(file);
const sqlite = db.prepare("SELECT sqlite_version() AS version").get().version;
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE probe(id TEXT PRIMARY KEY) STRICT; BEGIN IMMEDIATE; INSERT INTO probe VALUES('committed'); COMMIT; BEGIN IMMEDIATE; INSERT INTO probe VALUES('rolledback'); ROLLBACK;",
);
db.close();
db = new DatabaseSync(file);
const rows = db.prepare("SELECT * FROM probe").all();
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
if (rows.length !== 1 || rows[0].id !== "committed" || integrity !== "ok")
  throw Error("Storage runtime probe failed");
db.close();
console.log(
  JSON.stringify({
    executable: process.execPath,
    node: process.versions.node,
    electron: process.versions.electron,
    sqlite,
    integrity,
    file,
  }),
);
