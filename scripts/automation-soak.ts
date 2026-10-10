/** Isolated fixture runner. This command cannot enable unattended publication. */
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { strict as assert } from "node:assert";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const faults = [
  "process-kill",
  "lost-success",
  "body-abort",
  "auth",
  "enospc",
  "fsync",
  "lease",
  "unknown-session",
] as const;
type Slot = (typeof faults)[number];
interface Remote {
  sessions: number;
  accepted: number;
  requests: number;
  faults: number;
}
interface ChildResult {
  kind: "result";
  token: string;
  state: string;
  claims: number;
  deliveries: number;
  artifact: string;
  deliveryId?: string;
  packageHash: string;
  staleWritesRejected: number;
  authRetries: number;
  generation: number;
}
export interface SoakReport {
  version: 1;
  seed: string;
  sourceCommit: string;
  sourceDigest: string;
  node: string;
  tsx: string;
  lockfileDigest: string;
  startedAt: string;
  lastObservedAt: string;
  endedAt?: string;
  activeSeconds: number;
  wallSeconds: number;
  downtimeSeconds: number;
  sessions: number;
  status:
    | "running"
    | "interrupted"
    | "failed"
    | "short-profile-complete"
    | "72h-complete";
  releaseGate72h: boolean;
  episodes: number;
  cycles: number;
  nextSlot: number;
  faults: Record<string, number>;
  killedChildren: number;
  staleWritesRejected: number;
  authRetries: number;
  duplicateRemoteAcceptances: number;
  duplicateLocalClaims: number;
  lostArtifacts: number;
  unresolved: string[];
  invariantFailures: string[];
  activeRuns: {
    pid: number;
    startedAt: string;
    activeSeconds: number;
    endedAt?: string;
  }[];
  eventLogTruncated: boolean;
  outcomes: Record<string, ChildResult>;
  processEvidence: {
    pid: number;
    token: string;
    signal: string;
    generation: number;
  }[];
}
export function observedDelta(previous: bigint, now: bigint) {
  const delta = Number(now - previous) / 1e9;
  // Reject unobserved scheduler/suspend gaps, rather than crediting old wall time.
  return delta >= 0 && delta <= 2.5 ? delta : 0;
}
function atomic(file: string, value: unknown) {
  const tmp = file + ".tmp",
    fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
function sha(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
export function openFixtureRoot(input: string, seed: string) {
  let root = path.resolve(input);
  assert(
    path.basename(root).startsWith("capy-isolated-soak-"),
    "Use a dedicated capy-isolated-soak-* directory, never application data/output",
  );
  assert(seed.length > 0 && seed.length <= 100, "Invalid fixture seed");
  if (!fs.existsSync(root))
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assert(
    !fs.lstatSync(root).isSymbolicLink(),
    "Fixture root must not be a symlink",
  );
  root = fs.realpathSync(root);
  const marker = path.join(root, ".capy-isolated-soak.json");
  if (fs.existsSync(marker)) {
    const saved = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert(
      saved.version === 1 && saved.root === root && saved.seed === seed,
      "Fixture marker mismatch; refusing application root",
    );
  } else {
    assert(
      fs.readdirSync(root).length === 0,
      "Isolated root must initially be empty",
    );
    atomic(marker, { version: 1, root, seed });
  }
  return root;
}
function sourceEvidence() {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "server",
      "lib",
      "scripts",
      "test/fixtures/automation-soak-child.ts",
      "test/publication-fixtures.ts",
      "package.json",
      "pnpm-lock.yaml",
    ],
    { cwd: repo, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .sort();
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(repo, f)));
  }
  return {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
    sourceDigest: hash.digest("hex"),
    node: process.version,
    tsx: JSON.parse(
      fs.readFileSync(path.join(repo, "node_modules/tsx/package.json"), "utf8"),
    ).version as string,
    lockfileDigest: sha(path.join(repo, "pnpm-lock.yaml")),
  };
}
function boundedTree(root: string) {
  let bytes = 0,
    files = 0;
  const visit = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      assert(!ent.isSymbolicLink(), "Symlink inside fixture root");
      const f = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(f);
      else {
        bytes += fs.statSync(f).size;
        files++;
      }
    }
  };
  visit(root);
  assert(
    bytes < 32 * 1024 * 1024 && files < 300,
    "Fixture disk bound exceeded",
  );
}
export interface SoakOptions {
  root: string;
  seed: string;
  durationSeconds: number;
  intervalSeconds: number;
  cycles?: number;
  signal?: AbortSignal;
}
export async function runSoak(options: SoakOptions): Promise<SoakReport> {
  assert(
    Number.isFinite(options.durationSeconds) &&
      options.durationSeconds >= 0 &&
      options.durationSeconds <= 7 * 86400,
    "Duration must be between zero and seven days",
  );
  assert(
    Number.isFinite(options.intervalSeconds) &&
      options.intervalSeconds >= 0 &&
      options.intervalSeconds <= 3600,
    "Invalid interval",
  );
  if (options.durationSeconds >= 259200)
    assert(
      options.intervalSeconds >= 10,
      "Long run requires a bounded cadence of at least ten seconds",
    );
  const root = openFixtureRoot(options.root, options.seed),
    lock = path.join(root, "runner.lock");
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    assert(Number.isInteger(pid) && pid > 0, "Corrupt fixture runner lock");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw e;
    }
    assert(!alive, "Fixture runner is already active (or PID was reused)");
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  const runFile = path.join(root, "run.json"),
    remoteFile = path.join(root, "fake-remote.json");
  let child: ChildProcess | undefined,
    childToken = "",
    ready = false,
    generation = 0,
    killRequested = false;
  let report: SoakReport | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  const remote: Record<string, Remote> = fs.existsSync(remoteFile)
    ? JSON.parse(fs.readFileSync(remoteFile, "utf8"))
    : Object.fromEntries(
        faults.map((f) => [
          f,
          { sessions: 0, accepted: 0, requests: 0, faults: 0 },
        ]),
      );
  const server = createServer(async (req, res) => {
    try {
      assert(
        req.headers["x-fixture-token"] === childToken && ready,
        "Unowned fixture request",
      );
      const url = new URL(req.url!, "http://127.0.0.1"),
        slot = url.pathname.split("/")[1] as Slot;
      assert(faults.includes(slot));
      const r = remote[slot]!;
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert(size <= 8192, "Oversize fixture request");
      }
      r.requests++;
      const fault = req.headers["x-fixture-operation"] === "fault";
      const upload =
        req.method === "PUT" && req.headers["content-length"] !== "0";
      const init = req.method === "POST" && url.searchParams.has("uploadType");
      if (init) r.sessions++;
      if (upload) r.accepted++;
      atomic(remoteFile, remote); // Acceptance lives independently of child and its SQLite DB.
      if (
        fault &&
        (upload || (!init && req.method === "GET")) &&
        slot === "process-kill"
      ) {
        assert(
          child && child.pid && ready && !child.killed,
          "Unowned kill refused",
        );
        killRequested = true;
        report!.processEvidence.push({
          pid: child.pid,
          token: childToken,
          signal: "SIGKILL",
          generation,
        });
        report!.processEvidence = report!.processEvidence.slice(-32);
        child.kill("SIGKILL");
        res.destroy();
        return;
      }
      if (
        fault &&
        (upload || (!init && req.method === "GET")) &&
        ["lost-success", "body-abort", "unknown-session"].includes(slot)
      ) {
        r.faults++;
        atomic(remoteFile, remote);
        if (slot === "body-abort") {
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": "1000",
          });
          res.write('{"id":');
          setTimeout(() => res.destroy(), 20);
        } else res.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (init) {
        res.setHeader("location", `https://fixture.invalid/session/${slot}`);
        res.end();
      } else if (req.method === "PUT") {
        if (slot === "unknown-session" && r.accepted) {
          res.statusCode = 404;
          res.end("{}");
        } else if (r.accepted)
          res.end(JSON.stringify({ id: `fixture-${slot}` }));
        else {
          res.statusCode = 308;
          res.end();
        }
      } else {
        assert(
          r.accepted === 1,
          "Remote public lookup without exactly one acceptance",
        );
        res.end(
          JSON.stringify({
            items: [
              {
                status: { uploadStatus: "processed", privacyStatus: "public" },
              },
            ],
          }),
        );
      }
    } catch (error) {
      res.destroy();
      if (report) report.invariantFailures.push(String(error).slice(0, 300));
    }
  });
  try {
    const evidence = sourceEvidence();
    if (fs.existsSync(runFile)) {
      report = JSON.parse(fs.readFileSync(runFile, "utf8")) as SoakReport;
      assert(
        report.version === 1 &&
          report.seed === options.seed &&
          report.sourceDigest === evidence.sourceDigest &&
          report.node === evidence.node &&
          report.lockfileDigest === evidence.lockfileDigest,
        "Resume source/runtime/seed evidence changed; use a new root",
      );
      assert(
        report.invariantFailures.length === 0,
        "Cannot resume failed invariant evidence",
      );
      assert(
        report.activeSeconds >= 0 && Number.isFinite(report.activeSeconds),
        "Invalid active duration ledger",
      );
      report.sessions++;
    } else
      report = {
        version: 1,
        seed: options.seed,
        ...evidence,
        startedAt: new Date().toISOString(),
        lastObservedAt: new Date().toISOString(),
        activeSeconds: 0,
        wallSeconds: 0,
        downtimeSeconds: 0,
        sessions: 1,
        status: "running",
        releaseGate72h: false,
        episodes: 0,
        cycles: 0,
        nextSlot: 0,
        faults: {},
        killedChildren: 0,
        staleWritesRejected: 0,
        authRetries: 0,
        duplicateRemoteAcceptances: 0,
        duplicateLocalClaims: 0,
        lostArtifacts: 0,
        unresolved: [],
        invariantFailures: [],
        activeRuns: [],
        eventLogTruncated: false,
        outcomes: {},
        processEvidence: [],
      };
    report.status = "running";
    report.endedAt = undefined;
    report.releaseGate72h = false;
    const save = () => {
      report!.lastObservedAt = new Date().toISOString();
      report!.wallSeconds = Math.max(
        0,
        (Date.now() - Date.parse(report!.startedAt)) / 1000,
      );
      report!.downtimeSeconds = Math.max(
        0,
        report!.wallSeconds - report!.activeSeconds,
      );
      atomic(runFile, report);
    };
    const activeRun = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      activeSeconds: 0,
      endedAt: undefined as string | undefined,
    };
    report.activeRuns.push(activeRun);
    assert(
      report.activeRuns.length <= 128,
      "Maximum resume sessions reached; retain evidence and use a new root",
    );
    let previous = process.hrtime.bigint();
    const observe = () => {
      const now = process.hrtime.bigint();
      const delta = observedDelta(previous, now);
      report!.activeSeconds += delta;
      activeRun.activeSeconds += delta;
      previous = now;
    };
    timer = setInterval(() => {
      observe();
      save();
    }, 1000);
    save();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const launch = async (
      slot: Slot,
      operation: string,
    ): Promise<ChildResult | undefined> => {
      ready = false;
      generation = 0;
      killRequested = false;
      childToken = randomUUID();
      const expectedToken = childToken;
      const dir = path.join(root, slot);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      child = spawn(
        process.execPath,
        [
          "--experimental-sqlite",
          "--import",
          path.join(repo, "node_modules/tsx/dist/loader.mjs"),
          path.join(repo, "test/fixtures/automation-soak-child.ts"),
          dir,
          slot,
          origin,
          expectedToken,
          operation,
        ],
        {
          cwd: repo,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: path.join(root, "home"),
            TMPDIR: root,
            CAPY_DATA_DIR: dir,
            NODE_ENV: "test",
          },
        },
      );
      const owned = child;
      let result: ChildResult | undefined,
        log = "";
      owned.stdout?.on("data", (c) => {
        log = (log + String(c)).slice(-8192);
      });
      owned.stderr?.on("data", (c) => {
        log = (log + String(c)).slice(-8192);
      });
      owned.on("message", (message) => {
        const m = message as {
          kind: string;
          token: string;
          pid?: number;
          generation: number;
        };
        if (m.token !== expectedToken) return;
        if (m.kind === "ready") {
          assert(m.pid === owned.pid);
          ready = true;
          generation = m.generation;
        }
        if (m.kind === "result") result = message as ChildResult;
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          owned.kill("SIGKILL");
          reject(Error(`Fixture child timeout: ${slot}: ${log}`));
        }, 15000);
        const abort = () => {
          owned.kill("SIGKILL");
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        owned.once("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        owned.once("exit", (code, signal) => {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", abort);
          if (options.signal?.aborted) {
            reject(Error("Soak interrupted"));
            return;
          }
          if (killRequested && signal === "SIGKILL") {
            report!.killedChildren++;
            resolve();
          } else if (code === 0 && result) resolve();
          else
            reject(
              Error(
                `Fixture ${slot}/${operation} exited ${code}/${signal}: ${log}`,
              ),
            );
        });
      });
      child = undefined;
      if (result) {
        report!.staleWritesRejected += result.staleWritesRejected;
        report!.authRetries += result.authRetries;
        report!.outcomes[slot] = result;
      }
      return result;
    };
    const check = () => {
      report!.duplicateRemoteAcceptances = Object.values(remote).reduce(
        (sum, r) => sum + Math.max(0, r.accepted - 1),
        0,
      );
      report!.duplicateLocalClaims = Object.values(report!.outcomes).reduce(
        (sum, r) => sum + Math.max(0, r.claims - 1, r.deliveries - 1),
        0,
      );
      report!.lostArtifacts = 0;
      for (const slot of faults) {
        const artifact = path.join(root, slot, "fixture.mp4"),
          digest = path.join(root, slot, "artifact.sha256");
        if (
          fs.existsSync(digest) &&
          (!fs.existsSync(artifact) ||
            sha(artifact) !== fs.readFileSync(digest, "utf8"))
        )
          report!.lostArtifacts++;
      }
      report!.unresolved = Object.entries(report!.outcomes)
        .filter(([, r]) => r.state === "delivery-unknown")
        .map(([s]) => s);
      assert.equal(
        report!.duplicateRemoteAcceptances,
        0,
        "Duplicate remote acceptance",
      );
      assert.equal(report!.duplicateLocalClaims, 0, "Duplicate local claim");
      assert.equal(report!.lostArtifacts, 0, "Lost immutable artifact");
      for (const [slot, outcome] of Object.entries(report!.outcomes)) {
        const r = remote[slot]!;
        assert(
          ["public", "delivery-unknown"].includes(outcome.state),
          "Recovery did not establish an explicit terminal or unresolved state",
        );
        assert(r.sessions <= 1, "Duplicate remote initialization");
        if (outcome.state === "public")
          assert.equal(r.accepted, 1, "Local/remote publication mismatch");
        if (
          r.accepted &&
          !["public", "delivery-unknown"].includes(outcome.state)
        )
          throw Error(
            `Unlisted unresolved remote acceptance: ${slot}/${outcome.state}`,
          );
      }
      assert.equal(
        report!.invariantFailures.length,
        0,
        "Fixture remote invariant failed",
      );
      boundedTree(root);
    };
    const offset =
      createHash("sha256").update(options.seed).digest()[0]! % faults.length;
    const order = [...faults.slice(offset), ...faults.slice(0, offset)];
    const startCycles = report.cycles;
    do {
      for (; report.nextSlot < faults.length; report.nextSlot++) {
        if (options.signal?.aborted) throw Error("Soak interrupted");
        const slot = order[report.nextSlot]!;
        await launch(slot, "fault");
        // A killed/ambiguous executor is always followed by a fresh process with a real lease.
        await launch(slot, "recover");
        report.faults[slot] = (report.faults[slot] ?? 0) + 1;
        report.episodes++;
        check();
        const log = path.join(root, "fault-events.ndjson");
        if (!fs.existsSync(log) || fs.statSync(log).size < 1024 * 1024)
          fs.appendFileSync(
            log,
            JSON.stringify({
              at: new Date().toISOString(),
              episode: report.episodes,
              slot,
              state: report.outcomes[slot]?.state,
              killedChildren: report.killedChildren,
            }) + "\n",
            { mode: 0o600 },
          );
        else report.eventLogTruncated = true;
        save();
        if (options.intervalSeconds) {
          const until = Date.now() + options.intervalSeconds * 1000;
          while (Date.now() < until) {
            if (options.signal?.aborted) throw Error("Soak interrupted");
            await new Promise((r) =>
              setTimeout(r, Math.min(500, until - Date.now())),
            );
          }
        }
      }
      report.nextSlot = 0;
      report.cycles++;
      observe();
      check();
      assert.equal(
        sourceEvidence().sourceDigest,
        report.sourceDigest,
        "Source changed during soak; evidence is invalid",
      );
      save();
    } while (
      report.activeSeconds < options.durationSeconds ||
      report.cycles - startCycles < (options.cycles ?? 1)
    );
    check();
    activeRun.endedAt = new Date().toISOString();
    report.releaseGate72h =
      options.durationSeconds >= 259200 && report.activeSeconds >= 259200;
    report.status = report.releaseGate72h
      ? "72h-complete"
      : "short-profile-complete";
    report.endedAt = new Date().toISOString();
    save();
    return report;
  } catch (error) {
    if (report) {
      report.status = options.signal?.aborted ? "interrupted" : "failed";
      if (!options.signal?.aborted)
        report.invariantFailures.push(String(error).slice(0, 2000));
      report.releaseGate72h = false;
      report.endedAt = new Date().toISOString();
      const activeRun = report.activeRuns.at(-1);
      if (activeRun?.pid === process.pid) activeRun.endedAt = report.endedAt;
      atomic(runFile, report);
    }
    throw error;
  } finally {
    clearInterval(timer);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const owned = child;
      await new Promise<void>((resolve) => {
        owned.once("exit", () => resolve());
        owned.kill("SIGKILL");
      });
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => controller.abort());
  const root = get("--root"),
    seed = get("--seed");
  if (!root || !seed)
    throw Error(
      "Required: --root /absolute/capy-isolated-soak-NAME --seed NAME [--duration-hours 72] [--interval-seconds 60]",
    );
  runSoak({
    root,
    seed,
    durationSeconds: Number(get("--duration-hours") ?? 72) * 3600,
    intervalSeconds: Number(get("--interval-seconds") ?? 60),
    signal: controller.signal,
  })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
