import { z } from "zod";
import { prepareRenderReview } from "@/server/studio/render";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
const Input = z.strictObject({
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  platform: z.enum(["youtube", "instagram", "tiktok"]),
  text: z.strictObject({
    title: z.string().max(100).optional(),
    description: z.string().max(5000).optional(),
    caption: z.string().max(2200).optional(),
    tags: z.array(z.string().max(100)).max(100).optional(),
  }),
});
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; renderId: string }> },
) {
  try {
    const body = Input.parse(await req.json()),
      { id, renderId } = await ctx.params;
    return Response.json(
      await prepareRenderReview(
        id,
        renderId,
        body.checksum,
        body.platform,
        body.text,
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
