import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { postYouTube } from "../server/platforms/youtube";
it.each([200, 403, 0])(
  "records actual selected thumbnail upload separately from download (%s)",
  async (status) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "capy-thumb-upload-"));
    try {
      const file = path.join(root, "video.mp4"),
        thumbFile = path.join(root, "exact-selection.jpg"),
        bytes = Buffer.from([255, 216, 255, 1]);
      await writeFile(file, "fixture-video");
      await writeFile(thumbFile, bytes);
      const checkpoints: Record<string, string>[] = [];
      let received: Buffer | undefined;
      const fetcher = (async (url: string, init?: RequestInit) => {
        if (url.includes("uploadType=resumable"))
          return new Response("{}", {
            headers: { location: "https://fixture/upload" },
          });
        if (url === "https://fixture/upload")
          return Response.json({ id: "fixture" });
        if (url.includes("thumbnails/set")) {
          received = Buffer.from(await (init!.body as Blob).arrayBuffer());
          if (!status) throw Error("fixture transport lost");
          return Response.json({}, { status });
        }
        return Response.json({
          items: [
            { status: { uploadStatus: "processed", privacyStatus: "public" } },
          ],
        });
      }) as typeof fetch;
      const result = await postYouTube(
        { file, thumbFile, text: { title: "fixture" } },
        {
          token: "fake",
          fetch: fetcher,
          sleep: async () => {},
          log: () => {},
          checkpoint: (p) => checkpoints.push(p),
        },
      );
      expect(result.kind).toBe("posted");
      expect(received).toEqual(bytes);
      expect(checkpoints.at(-1)).toMatchObject({
        thumbnailStatus:
          status === 200 ? "accepted" : status === 403 ? "refused" : "unknown",
        thumbnailChecksum: createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
