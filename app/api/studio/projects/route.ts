import { createProject, listProjects } from "@/server/studio/projects";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(listProjects());
}
export async function POST(req: Request) {
  try {
    return Response.json(await createProject(await req.json()), {
      status: 201,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
