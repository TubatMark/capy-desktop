# A2 durable storage and import

Implemented native node:sqlite storage with WAL, FULL synchronous durability, finite busy timeout, foreign keys, schema user_version, STRICT JSON documents and unique identity keys. Generic namespaced documents serve projects/assets and later work/AI/discovery records without secondary JSON state. Project saves use transactional expected-revision comparison; duplicate revisions conflict across separate processes. Nested synchronous transactions use savepoints; async callbacks are rejected.

Jobs, watch and queue now persist authoritative state to capy.sqlite under CAPY_DATA_DIR. Legacy JSON remains untouched as recovery material; it is not written after migration. Watch/queue mutations read and write inside BEGIN IMMEDIATE instead of process-local JSON locks. Credentials/settings remain in their current store. readJsonFile treats only ENOENT as absent; parse and permission failures are visible.

Legacy import validates all records before transactional insertion, preserves original JSON/media, creates source backups and an integrity-checked VACUUM INTO pre-import SQLite snapshot, records source imports for repeatability, and writes a report. Interrupted transactions rollback and restart. Existing database documents win over legacy copies. Assets retain original locations; moved files resolve by sibling filename, absent files remain missing/relinkable. Legacy assets deliberately do not invent content checksums. Source JSON is recovery-only after import; edits to old files are not a second authoritative write path.

Runtime contract: exact Electron44.5.1 and .node-version22.12.0; engines >=22.12.0. scripts/with-sqlite.mjs appends --experimental-sqlite while preserving NODE_OPTIONS. Package dev/build/start/test/desktop build/pack launch through wrapper. No machine installation/config changes. Node builtin needs no native-addon rebuild.

Validation:
- RED: initial storage suite failed missing ../server/db before adapter existed.
- GREEN: focused storage/import/jobs/watch/queue: 54 tests passed.
- Full suite: 45 files, 392 tests passed via SQLite wrapper.
- pnpm typecheck passed.
- Two actual independent Node processes racing expected revision4: exactly saved/conflict; reopened revision5.
- Import tests cover interrupt/restart, repeat identifiers/counts, backup existence, malformed JSON visible failure with zero activation, unchanged media, moved file and missing asset.
- Installed Electron server-style executable (ELECTRON_RUN_AS_NODE=1) ran scripts/storage-probe.mjs against a fresh temp path containing spaces: Node24.21.0, SQLite3.53.4, commit/rollback/reopen/integrity ok. This is installed executable evidence, not produced packaged application evidence.

Outstanding integration gate: controller must build/package sources after all parallel changes settle, run the produced app executable with ELECTRON_RUN_AS_NODE=1 against scripts/storage-probe.mjs, then launch its actual standalone server with isolated CAPY_DATA_DIR to exercise storage tracing/import/API startup. A2 packaging requirement remains pending until that succeeds. Schema1 is initial installation; later version migrations must validate staged copies/inventories rather than alter live databases untested. Store.put is an explicit unconditional low-level operation for imports/internal writes; callers needing user revision protection must use save or conditional SQL within transaction. Legacy job manager still has in-memory live job state; A3 must fence worker publication writes rather than use unconditional legacy saves for concurrent workers.

No real user directories, providers, accounts or publishing were exercised.
