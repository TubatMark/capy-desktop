import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * One poster per data folder. The packaged app in the menu bar and a `pnpm dev` server share
 * ~/Library/Application Support/capy; without this both would post (and each would treat the other's
 * uploads as interrupted). The holder refreshes `beat` every tick; a dead or silent holder is taken over.
 */

const STALE_MS = 90_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/** "acquired": newly ours (recover interrupted uploads); "held": still ours; "busy": another live process has it. */
export function takePosterLock(file: string, now: number): "acquired" | "held" | "busy" {
  let cur: { pid?: number; beat?: number } = {};
  try {
    cur = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* no lock yet */
  }
  const mine = cur.pid === process.pid;
  if (!mine && cur.pid && alive(cur.pid) && now - (cur.beat ?? 0) < STALE_MS) return "busy";
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, beat: now }));
  renameSync(tmp, file);
  return mine ? "held" : "acquired";
}
