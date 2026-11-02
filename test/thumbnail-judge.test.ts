import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { run } from "../src/exec";
import { judgeThumbnails, orderByReview, reviewThumbnails } from "../server/thumbnail-judge";
import { buildAss, STYLES } from "../src/ass";
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

it("the review can reject: passing designs lead, weak ones follow, severe ones go last", async () => {
  const designs = [await design("top", "red"), await design("next", "blue"), await design("third", "green")];
  const review = await reviewThumbnails({ designs, title: "A clip", directory: dir }, async (_p, o) => {
    expect(o.images.map((i) => i.label)).toEqual(["Design A", "Design B", "Design C"]);
    const data = {
      designs: [
        { design: "A", ok: false, severe: true, problems: "A slur is readable in the caption." },
        { design: "B", ok: false, severe: false, problems: "Player controls show." },
        { design: "C", ok: true, severe: false },
      ],
    };
    expect(o.validate(data)).toBe(true);
    expect(o.validate({ designs: [{ design: "A" }] })).toBe(false);
    return { data };
  });
  expect(review.by).toBe("ai");
  expect(orderByReview(designs, review).map((d) => d.id)).toEqual(["third", "next", "top"]);
  expect(review.of.top).toEqual({ ok: false, severe: true, problems: "A slur is readable in the caption." });
});

it("a severe finding can't also pass", async () => {
  const designs = [await design("both", "red")];
  const review = await reviewThumbnails({ designs, directory: dir }, async () => ({ data: { designs: [{ design: "A", ok: true, severe: true }] } }));
  expect(review.of.both).toEqual({ ok: false, severe: true });
});

it("without a review answer the ranking stands and nothing is held", async () => {
  const designs = [await design("r1", "red"), await design("r2", "blue")];
  const review = await reviewThumbnails({ designs, directory: dir }, async () => {
    throw new Error("no login");
  });
  expect(review.by).toBe("default");
  expect(review.reason).toMatch(/unavailable/);
  expect(orderByReview(designs, review).map((d) => d.id)).toEqual(["r1", "r2"]);
});

it("a Short's captions and hook never spell a slur out", () => {
  const ass = buildAss([{ text: "nigga", start: 0, end: 1 }], STYLES.bold!, { text: "that nigga asked", seconds: 1 });
  expect(ass.toLowerCase()).not.toContain("nigga");
  expect(ass).toContain("N****");
});
