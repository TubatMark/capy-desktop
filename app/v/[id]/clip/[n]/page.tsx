import { ClipEditor } from "@/components/clip-editor";

export default async function ClipPage({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  // key: fresh editor state (draft, lock) when moving between clips
  return <ClipEditor key={`${id}/${n}`} id={id} n={Number(n)} />;
}
