import { it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runSoak,
  openFixtureRoot,
  observedDelta,
} from "../scripts/automation-soak";

it("refuses ordinary/nonempty roots and excludes suspend/downtime from active duration", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ordinary-app-"));
  try {
    expect(() => openFixtureRoot(root, "test")).toThrow(/isolated/);
    expect(observedDelta(0n, 1_000_000_000n)).toBe(1);
    expect(observedDelta(0n, 60_000_000_000n)).toBe(0);
    const dirty = mkdtempSync(path.join(tmpdir(), "capy-isolated-soak-dirty-"));
    try {
      writeFileSync(path.join(dirty, "settings.json"), "{}");
      expect(() => openFixtureRoot(dirty, "test")).toThrow(/empty/);
    } finally {
      rmSync(dirty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("real process kill/takeover and fault ledger preserve artifacts and unique claims", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-isolated-soak-"));
  try {
    const report = await runSoak({
      root,
      seed: "short-test",
      durationSeconds: 0,
      intervalSeconds: 0,
      cycles: 1,
    });
    expect(report.status).toBe("short-profile-complete");
    expect(report.releaseGate72h).toBe(false);
    expect(report.activeSeconds).toBeLessThan(259200);
    expect(report.invariantFailures).toEqual([]);
    expect(report.killedChildren).toBeGreaterThan(0);
    expect(report.staleWritesRejected).toBeGreaterThan(0);
    expect(report.duplicateRemoteAcceptances).toBe(0);
    expect(report.lostArtifacts).toBe(0);
    expect(report.duplicateLocalClaims).toBe(0);
    expect(report.unresolved).toEqual(["unknown-session"]);
    for (const [slot, result] of Object.entries(report.outcomes))
      expect(result.state).toBe(
        slot === "unknown-session" ? "delivery-unknown" : "public",
      );
    expect(report.processEvidence[0]).toMatchObject({ signal: "SIGKILL" });
    expect(report.outcomes["process-kill"]!.generation).toBeGreaterThan(
      report.processEvidence[0]!.generation,
    );
    expect(report.activeRuns[0]!.activeSeconds).toBeGreaterThan(0);
    expect(report.faults).toEqual(
      expect.objectContaining({
        "process-kill": 1,
        "lost-success": 1,
        "body-abort": 1,
        auth: 1,
        enospc: 1,
        fsync: 1,
        lease: 1,
        "unknown-session": 1,
      }),
    );
    const old = JSON.parse(readFileSync(path.join(root, "run.json"), "utf8"));
    old.startedAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(path.join(root, "run.json"), JSON.stringify(old));
    const resumed = await runSoak({
      root,
      seed: "short-test",
      durationSeconds: 0,
      intervalSeconds: 0,
      cycles: 1,
    });
    expect(resumed.releaseGate72h).toBe(false);
    expect(resumed.sessions).toBe(2);
    expect(resumed.activeRuns).toHaveLength(2);
    expect(resumed.downtimeSeconds).toBeGreaterThan(86400);
    expect(resumed.duplicateRemoteAcceptances).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
