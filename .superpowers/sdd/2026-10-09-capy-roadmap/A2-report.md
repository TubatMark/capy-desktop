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

Post-commit durability review: expanded all new production modules into conventional readable TS. Transaction depth now restores the entry value in finally, including COMMIT/RELEASE failures; rollback failure cannot mask the original operation error. Added a deferred foreign-key failure at COMMIT followed by a successful transaction and nested savepoint rollback test. Focused storage/import now6 tests passed; typecheck passed. Initial implementation commit8a7ff3d; follow-up fix covers this review.

## A2 review round1 corrections

Read all three A2-review.md findings. Added schema validation of required job/settings/clip/render/estimate/log, watch/channel/settings/seen/pending/history and queue/text/history/identity fields plus optional downstream nested shapes. Safe relative directory identity is enforced during source import. Authoritative database jobs and watch/queue state validate on read; JobManager failures propagate instead of falling through to CLI metadata. Only absent job.json with present meta.json follows the CLI path.

Completed source markers now precede parsing/validation. Changed, corrupt or missing recovery originals produce visible report diagnostics and immutable namespaced diagnostic records with original/observed digests; startup warns them and keeps loading healthy activated state. Completed markers and import-history preserve original digest and backup location. Lazy watch/queue migration also records markers/history transactionally, checks for an existing concurrent winner before insertion, and keeps originals unchanged. No-op/empty imports return backupLocation:null without creating directories or full SQLite snapshots; real activation retains the source backups and consistent pre-import database snapshot.

RED command: node scripts/with-sqlite.mjs pnpm exec vitest run test/legacy-import.test.ts. Output:3 failed/2 passed (incomplete shape activated; corrupt recovery original blocked; empty import allocated snapshot). GREEN command: node scripts/with-sqlite.mjs pnpm exec vitest run test/storage.test.ts test/legacy-import.test.ts test/jobs.test.ts test/watch.test.ts test/queue.test.ts. Output:5 files/59 tests passed. pnpm typecheck:passed. The JobManager test invokes fresh init against invalid authoritative state plus older CLI metadata and confirms rejection without replacing the job. All tests use disposable paths.

Worker schema/API unchanged: documents(kind,id,revision,body), identities(kind,key,document_id), imports(source,digest,imported_at). Store.transaction synchronous and nested; Store.save CAS; raw db for fenced SQL. New validator exports jobSchema/watchSchema/queueSchema and validateLegacy. import-history/import-diagnostics are document namespaces, no second migration or JSON truth. Packaged gate remains outstanding.
