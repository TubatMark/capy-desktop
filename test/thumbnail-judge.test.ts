import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { run } from "../src/exec";
import { judgeThumbnails } from "../server/thumbnail-judge";
import type { ThumbnailDesign } from "../lib/thumbnails";

const dir = mkdtempSync(path.join(tmpdir(), "capy-judge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function design(id: string, color: string): Promise<ThumbnailDesign> {
  const file = path.join(dir, `${id}.jpg`);
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:size=1080x1920`, "-frames:v", "1", "-y", file], { timeoutMs: 30_000 });
  return { id, layout: "bold", versions: [{ id: `${id}-v`, checksum: "x", path: file, format: "jpg", width: 1080, height: 1920, createdAt: 1 }] } as unknown as ThumbnailDesign;
}

it("the reviewer's ranking decides the order and the winner keeps its reason; images go at feed size", async () => {
  const designs = [await design("orig", "red"), await design("bold", "blue"), await design("min", "green")];
  let seen: { labels: string[]; bytes: number } | undefined;
  const j = await judgeThumbnails({ designs, title: "Kai Cenat tries hot cheetos seafood", directory: dir }, async (_p, o) => {
    seen = { labels: o.images.map((i) => i.label!), bytes: Math.max(...o.images.map((i) => i.data.length)) };
    const data = { ranking: ["B", "A", "C"], reason: "The face reads clearly at small size." };
    expect(o.validate(data)).toBe(true);
    expect(o.validate({ ranking: ["B", "B", "C"] })).toBe(false);
    return { data };
  });
  expect(seen!.labels).toEqual(["Design A", "Design B", "Design C"]);
  expect(j).toEqual({ order: ["bold", "orig", "min"], by: "ai", reason: "The face reads clearly at small size." });
});

it("without an answer the designs keep their order and the clip is not held up", async () => {
  const designs = [await design("orig2", "red"), await design("bold2", "blue")];
  const j = await judgeThumbnails({ designs, directory: dir }, async () => {
    throw new Error("AI budget exhausted: this video reached its $2.50 AI limit");
  });
  expect(j.order).toEqual(["orig2", "bold2"]);
  expect(j.by).toBe("default");
  expect(j.reason).toMatch(/unavailable/);
  // a single design needs no review
  expect((await judgeThumbnails({ designs: designs.slice(0, 1), directory: dir }, async () => { throw new Error("must not ask"); })).by).toBe("default");
});
