import { UrlForm } from "@/components/url-form";
import { SetupBanner } from "@/components/setup-banner";
import { LibraryGrid } from "@/components/library-grid";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

export default async function Home() {
  const m = jobs();
  await m.init();
  // only what the cards show, so a long library doesn't send every clip to the page
  const videos = [...m.list()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => ({
      id: j.id,
      videoId: j.videoId,
      title: j.title ?? j.url,
      channel: j.channel,
      duration: j.duration,
      status: j.status,
      clips: j.clips.length,
      rendered: j.clips.filter((c) => c.render.status === "done").length,
    }));

  return (
    <div className="space-y-6">
      <SetupBanner />

      <section className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Library</h1>
          <p className="text-pretty text-sm text-muted-foreground">capy clips the channels you watch by itself. To clip any other video, paste its link: AI finds the moments and you choose which ones to make.</p>
        </div>
        <UrlForm />
      </section>

      <LibraryGrid videos={videos} />
    </div>
  );
}
