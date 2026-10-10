import { StudioEditor } from "@/components/studio/editor";
export const dynamic = "force-dynamic";
export default async function StudioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StudioEditor id={id} />;
}
