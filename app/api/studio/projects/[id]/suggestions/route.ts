import path from "node:path";
import { realpath } from "node:fs/promises";
import { getProject } from "@/server/studio/projects";
import {
  listAssets,
  studioDependencies,
  checksum,
} from "@/server/studio/assets";
import { suggestEdits } from "@/server/studio/edit-suggestions";
import { run } from "@/src/exec";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params,
      body = await req.json(),
      doc = getProject(id);
    if (!doc)
      return Response.json({ error: "Project not found" }, { status: 404 });
    if (
      body.baseRevision !== doc.revision ||
      body.baseDocument !== JSON.stringify(doc)
    )
      return Response.json(
        { error: "Save your current revision before requesting suggestions" },
        { status: 409 },
      );
    if (
      !Array.isArray(body.selectedItemIds) ||
      body.selectedItemIds.length > 20
    )
      throw Error("Choose up to 20 items");
    const assets = await listAssets(),
      silence: Record<string, { startUs: number; endUs: number }[]> = {};
    const root = await realpath(studioDependencies().root);
    for (const itemId of body.selectedItemIds) {
      const item = doc.items.find((i) => i.id === itemId),
        asset = assets.find((a) => a.id === item?.assetId);
      if (!item || !asset || asset.status !== "ready")
        throw Error("Selected source unavailable");
      const file = await realpath(asset.location),
        relative = path.relative(root, file);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        (await checksum(file)) !== asset.checksum
      )
        throw Error("Selected source identity changed");
    }
    if (body.kind === "silence") {
      for (const itemId of body.selectedItemIds) {
        const item = doc.items.find((i) => i.id === itemId),
          asset = assets.find((a) => a.id === item?.assetId);
        if (!item || !asset || asset.status !== "ready")
          throw Error("Selected source unavailable");
        if (
          !asset.streams?.some((s) => s.kind === "audio") &&
          asset.kind !== "audio"
        )
          continue;
        if (
          (item.durationFrames * doc.fps.denominator) / doc.fps.numerator >
          600
        )
          throw Error("Select footage under ten minutes for silence analysis");
        const file = await realpath(asset.location),
          root = await realpath(studioDependencies().root),
          relative = path.relative(root, file);
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          (await checksum(file)) !== asset.checksum
        )
          throw Error("Selected source identity changed");
        const result = await run("ffmpeg", [
          "-v",
          "info",
          "-nostdin",
          "-ss",
          String(item.sourceInUs! / 1e6),
          "-t",
          String((item.sourceOutUs! - item.sourceInUs!) / 1e6),
          "-i",
          file,
          "-vn",
          "-af",
          "silencedetect=noise=-40dB:d=0.25",
          "-f",
          "null",
          "-",
        ]);
        let start: number | undefined;
        const spans: { startUs: number; endUs: number }[] = [];
        for (const match of result.stderr.matchAll(
          /silence_(start|end):\s*([\d.]+)/g,
        )) {
          const us = Number(match[2]) * 1e6 + item.sourceInUs!;
          if (match[1] === "start") start = us;
          else if (start !== undefined) {
            spans.push({ startUs: start, endUs: us });
            start = undefined;
          }
        }
        if (start !== undefined)
          spans.push({ startUs: start, endUs: item.sourceOutUs! });
        silence[itemId] = spans;
      }
    }
    return Response.json({
      operations: await suggestEdits({
        document: doc,
        selectedItemIds: body.selectedItemIds,
        kind: body.kind,
        fit: body.fit,
        silence,
        assets,
        speakerRegions: body.speakerRegions,
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
