import type { Metadata } from "next";
import { StoryStudio } from "@/components/stories/story-studio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Story · capy" };

export default async function StoryPage({ params }: { params: Promise<{ seriesId: string; storyId: string }> }) {
  const { seriesId, storyId } = await params;
  return (
    <div className="mx-auto w-full max-w-6xl">
      <StoryStudio seriesId={seriesId} id={storyId} />
    </div>
  );
}
