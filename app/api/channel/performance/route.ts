import { z } from "zod";
import { loadAccounts } from "@/server/accounts";
import {
  publicationMetrics,
  refreshPublicationMetrics,
  summarizeRecipePerformance,
  recordRemoteChange,
  purgePublicationMetrics,
} from "@/server/performance";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const account = () => {
  const a = loadAccounts().youtube;
  return a.tokens?.accessToken && !a.needsReconnect ? a.account?.id : undefined;
};
export async function GET(request: Request) {
  const id = account();
  if (!id)
    return Response.json(
      {
        error: "Connect the exact publishing channel to see its clip results.",
      },
      { status: 401 },
    );
  const recipe = new URL(request.url).searchParams.get("recipe");
  if (recipe && !/^[a-f0-9]{64}$/.test(recipe))
    return Response.json({ error: "Invalid recipe ID" }, { status: 400 });
  return Response.json(
    recipe
      ? await summarizeRecipePerformance(recipe, id)
      : publicationMetrics(id),
  );
}
const Action = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("refresh") }),
  z.strictObject({
    action: z.literal("remote-change"),
    remoteId: z.string().min(1).max(200),
    kind: z.enum(["thumbnail", "media"]),
    changedAt: z.number().finite().nonnegative().optional(),
  }),
]);
export async function POST(request: Request) {
  const id = account();
  if (!id)
    return Response.json(
      { error: "Connect the exact publishing channel." },
      { status: 401 },
    );
  const parsed = Action.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Invalid results action" }, { status: 400 });
  try {
    const a = parsed.data;
    return Response.json(
      a.action === "refresh"
        ? await refreshPublicationMetrics(id)
        : recordRemoteChange(id, a.remoteId, {
            kind: a.kind,
            changedAt: a.changedAt,
          }),
    );
  } catch {
    return Response.json(
      { error: "Could not update exact publication results." },
      { status: 409 },
    );
  }
}
export async function DELETE() {
  const id = account();
  if (!id)
    return Response.json(
      { error: "Connect the exact publishing channel." },
      { status: 401 },
    );
  purgePublicationMetrics(id);
  return Response.json(publicationMetrics(id));
}
