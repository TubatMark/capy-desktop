# Isolated delivery fault soak

This runner exercises the real `WorkQueue`, generation fences, SQLite delivery records, private checkpoints and YouTube adapter against a local fake provider. It does not read creator credentials, contact a provider, install a service, or change release locks. A successful fake-provider soak is not proof of an actual platform upload.

Run after implementation review and final source changes. The initial root must be empty and its basename must start with `capy-isolated-soak-`. Application data/output roots and root symlinks are refused. The runner creates its own marker, binds the fake provider to `127.0.0.1`, injects fake tokens, strips child environment variables to an explicit allow-list, and refuses non-loopback TCP connections, DNS/UDP calls and uninjected fetches in fixture children. Provider-shaped URLs are translated only by the injected fixture transport; redirects are refused.

From the repository root, run a short profile:

```sh
SOAK_ROOT="$(mktemp -d /tmp/capy-isolated-soak-short-XXXXXX)"
pnpm exec tsx scripts/automation-soak.ts --root "$SOAK_ROOT" --duration-hours 0 --interval-seconds 0 --seed c4-short
```

After review, start the actual long profile in a foreground terminal that remains open:

```sh
SOAK_ROOT="$(mktemp -d /tmp/capy-isolated-soak-72h-XXXXXX)"
printf '%s\n' "$SOAK_ROOT"
pnpm exec tsx scripts/automation-soak.ts --root "$SOAK_ROOT" --duration-hours 72 --interval-seconds 60 --seed c4-72h-v1
```

Save that printed path. Inspect progress from another terminal without stopping the runner:

```sh
cat "$SOAK_ROOT/run.json"
cat "$SOAK_ROOT/fake-remote.json"
tail -n 8 "$SOAK_ROOT/fault-events.ndjson"
```

`run.json` is atomically replaced and fsynced approximately once per second. `status: running` and `releaseGate72h: false` remain until the requested duration and all invariants are complete. The long result requires **259,200 actively observed seconds**. The runner measures elapsed time with `process.hrtime.bigint()`, discards observation gaps greater than 2.5 seconds, and persists per-process active totals. Downtime between invocations, system suspend, an old `startedAt`, and a changed wall clock cannot supply active duration. Unflushed time before a crash is conservatively excluded. The run may take longer than 72 wall-clock hours.

Use Ctrl-C to stop; the report becomes `interrupted`, owned children are stopped, and the runner lock is released. Resume using the **same path, seed and source/runtime**:

```sh
pnpm exec tsx scripts/automation-soak.ts --root "$SOAK_ROOT" --duration-hours 72 --interval-seconds 60 --seed c4-72h-v1
```

A dead runner's PID lock can be reclaimed, but an active or reused PID is refused. A fixture child exits when its parent IPC channel disappears. Source digest, Node version, dependency lock digest and seed must match on resume; source changes during a cycle fail the run. Keep the checkout unchanged for the long run. A failed invariant is retained and cannot be resumed as a passing run; investigate the evidence and use a new empty root after repair.

## Faults and evidence

The recorded seed determines the rotating order of eight permanent fixture slots. Each slot retains one tiny immutable rendered artifact, one approved package, one delivery identity and one reusable worker job. Each episode uses a fresh child for fault injection and another for recovery. Later cycles reuse completed deliveries and inject status-response failures; they do not create an unbounded sequence of uploads.

- **Process kill:** the independent remote ledger durably accepts bytes, then the runner sends actual `SIGKILL` to its IPC-identified child. Later cycles kill during a status query. A fresh child waits for real lease expiry, claims a higher generation and reconciles the saved remote operation. PID, random launch token, signal and generation are retained.
- **Lost success / body abort:** the loopback server durably records acceptance before dropping the socket or truncating its JSON body. Recovery uses the original saved session.
- **Auth:** an injected revoked-token `AuthError` stops the attempt; the next fixture child uses a valid fake token. This is fault-path evidence, not real OAuth refresh or account evidence.
- **Disk:** injected `ENOSPC` write and fsync exceptions exercise the real private-handle store without filling the host disk. The checkpoint must remain unchanged; the immutable artifact and prior remote handles remain readable.
- **Lease:** a real lease expires with heartbeats stopped. A replacement claims a new generation; stale job checkpoint and delivery creation attempts must fail.
- **Unknown session:** acceptance is followed by a lost success and expired-session 404. The durable delivery stays `delivery-unknown`, with no automatic new upload and no retry deadline. It remains explicitly listed on every cycle.

The fake remote ledger is a separately fsynced file, independent of worker SQLite. Each episode checks duplicate acceptance/initialization, local claim count, immutable artifact checksum, local/public versus remote acceptance, and explicit unresolved states. Any breach fails the runner. The report retains source commit plus source-content digest (including relevant uncommitted code), runtime/dependency versions, seed, UTC timestamps, active/wall/downtime totals, episode/fault counters, current outcomes and invariant failures.

Resource limits: eight artifacts/jobs, one fixture child at a time, a 15-second child timeout, 8 KiB maximum provider request, 8 KiB retained child error tail, last 32 kill records, at most 128 duration sessions, 1 MiB append-only fault sample, and a checked 32 MiB / 300-file root limit. Long profiles require at least ten seconds between episodes. Logs stop sampling at their cap and mark that fact; aggregate counters continue. SQLite WAL is checkpointed after each successful child. Neither unresolved deliveries nor completed artifacts are removed to make the result pass.

Run regression checks with `pnpm test test/automation-soak.test.ts`. They cover the real short runner, SIGKILL/takeover proof, resume, unsafe-root rejection and duration accounting. They deliberately cannot satisfy the 72-hour release gate. Even `72h-complete` is only isolated fake-provider evidence; separately authorized controlled upload, remote visibility/scheduling and thumbnail verification remain required before unattended enablement.
