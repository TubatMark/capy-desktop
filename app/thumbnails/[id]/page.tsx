import { ThumbnailStudio } from "@/components/thumbnails/studio";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ jobId?: string; clipN?: string; source?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  return (
    <ThumbnailStudio
      id={id}
      sourceQuery={query.source}
      legacy={
        query.jobId
          ? { jobId: query.jobId, clipN: Number(query.clipN) }
          : undefined
      }
    />
  );
}
