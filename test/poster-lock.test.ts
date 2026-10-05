import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { takePosterLock } from "../server/poster-lock";

let dir: string;
beforeAll(() => (dir = mkdtempSync(path.join(tmpdir(), "capy-lock-"))));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("takePosterLock", () => {
  it("acquires a free lock, then holds it", () => {
    const f = path.join(dir, "a.lock");
    expect(takePosterLock(f, 1000)).toBe("acquired");
    expect(takePosterLock(f, 2000)).toBe("held");
  });
  it("refuses while another live process holds a fresh lock", () => {
    const f = path.join(dir, "b.lock");
    writeFileSync(f, JSON.stringify({ pid: process.ppid, beat: 1000 }));
    expect(takePosterLock(f, 1000 + 30_000)).toBe("busy");
  });
  it("takes over a lock whose holder is gone or silent", () => {
    const dead = path.join(dir, "c.lock");
    writeFileSync(dead, JSON.stringify({ pid: 999_999_999, beat: 1000 }));
    expect(takePosterLock(dead, 2000)).toBe("acquired");
    const stale = path.join(dir, "d.lock");
    writeFileSync(stale, JSON.stringify({ pid: process.ppid, beat: 1000 }));
    expect(takePosterLock(stale, 1000 + 5 * 60_000)).toBe("acquired");
  });
});
