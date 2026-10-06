import type { Metadata } from "next";
import { SeriesView } from "@/components/stories/series-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Series · capy" };

export default async function SeriesPage({ params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  return (
    <div className="mx-auto w-full max-w-5xl">
      <SeriesView id={seriesId} />
    </div>
  );
}
