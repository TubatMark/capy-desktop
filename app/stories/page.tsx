import type { Metadata } from "next";
import { SeriesList } from "@/components/stories/series-list";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stories · capy" };

export default function StoriesPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <SeriesList />
    </div>
  );
}
