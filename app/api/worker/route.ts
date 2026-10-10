import { getWorkerHealth } from "@/server/worker/api";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getWorkerHealth());
}
