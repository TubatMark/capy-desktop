import { expect, it } from "vitest";
import { DraftJournal } from "../lib/studio/recovery";
import type { ProjectDocument } from "../lib/studio/types";
class MemoryStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(i: number) {
    return [...this.values.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.values.set(k, v);
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
}
const doc = (name: string): ProjectDocument => ({
  schemaVersion: 1,
  id: "p",
  revision: 1,
  name,
  canvas: { width: 1080, height: 1920 },
  fps: { numerator: 30, denominator: 1 },
  tracks: [],
  items: [],
  sourceMappings: [],
  captionCues: [],
  thumbnailIds: [],
});
it("one window's successful save cannot delete another window's conflicting edits", () => {
  const storage = new MemoryStorage();
  const a = new DraftJournal(storage, new MemoryStorage(), "p", "a");
  const b = new DraftJournal(storage, new MemoryStorage(), "p", "b");
  b.write(doc("B sending"));
  a.write(doc("A conflicting"));
  b.saved(doc("B sending"));
  expect(a.recover()?.document.name).toBe("A conflicting");
  expect(b.list().map((d) => d.document.name)).toEqual(["A conflicting"]);
});
it("reload keeps the session draft and fresh windows can choose orphaned drafts", () => {
  const storage = new MemoryStorage(),
    session = new MemoryStorage();
  const old = new DraftJournal(storage, session, "p", "old");
  old.write(doc("recover me"));
  const reload = new DraftJournal(storage, session, "p", "reload");
  expect(reload.recover()?.document.name).toBe("recover me");
  const fresh = new DraftJournal(storage, new MemoryStorage(), "p", "fresh");
  expect(fresh.recover()).toBeUndefined();
  expect(fresh.list()[0]?.document.name).toBe("recover me");
});
it("saving a stale predecessor leaves a concurrently updated draft intact", () => {
  const storage = new MemoryStorage(),
    session = new MemoryStorage();
  const old = new DraftJournal(storage, session, "p", "old");
  old.write(doc("old edit"));
  const next = new DraftJournal(storage, session, "p", "next");
  const recovered = next.recover()!;
  next.adopt(recovered);
  old.write(doc("new competing edit"));
  next.saved(doc("old edit"));
  expect(old.recover()?.document.name).toBe("new competing edit");
});

it("editing an explicitly recovered other-window draft never deletes its source", () => {
  const storage = new MemoryStorage();
  const a = new DraftJournal(storage, new MemoryStorage(), "p", "a");
  a.write(doc("A edits"));
  const b = new DraftJournal(storage, new MemoryStorage(), "p", "b");
  b.adopt(b.list()[0]!);
  b.write(doc("B variant"));
  b.saved(doc("B variant"));
  expect(a.recover()?.document.name).toBe("A edits");
});
