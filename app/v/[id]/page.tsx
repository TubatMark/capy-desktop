import { VideoView } from "@/components/video-view";

export default async function VideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VideoView id={id} />;
}
