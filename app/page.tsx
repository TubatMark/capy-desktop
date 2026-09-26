import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { UrlForm } from "@/components/url-form";
import { SetupBanner } from "@/components/setup-banner";
import { jobs } from "@/server/jobs";
import { fmtTime, ytThumb } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function Home() {
  const m = jobs();
  await m.init();
  const list = m.list();

  return (
    <div className="space-y-10 sm:space-y-12">
      <SetupBanner />

      <section className="mx-auto max-w-3xl pt-4 text-center sm:pt-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/capy-logo.png" alt="capy" className="mx-auto mb-2 h-28 w-auto drop-shadow-sm sm:h-44" />
        <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">Long video in. Shorts out.</h1>
        <p className="mt-3 text-pretty text-muted-foreground">Paste a YouTube link. AI finds the moments, you tweak them, capy renders captioned 9:16 clips on your Mac.</p>
        <div className="mt-6 sm:mt-8">
          <UrlForm large />
        </div>
      </section>

      <section className="min-w-0">
        <div className="mb-4 flex items-end justify-between gap-3">
          <h2 className="text-lg font-semibold">Your videos</h2>
          <span className="shrink-0 text-sm text-muted-foreground">{list.length} total</span>
        </div>
        {list.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed px-4 py-16 text-center text-muted-foreground sm:py-20">
            <Clapperboard className="mb-3 size-8 opacity-50" />
            <p>Nothing yet. Paste a link above to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {list.map((j) => (
              <Link key={j.id} href={`/v/${j.id}`} className="group min-w-0 overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/50">
                <div className="relative aspect-video bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ytThumb(j.videoId)} alt="" className="size-full object-cover transition-transform group-hover:scale-[1.02]" />
                  <div className="absolute bottom-2 right-2 flex gap-1">
                    {j.duration ? <Badge variant="secondary">{fmtTime(j.duration)}</Badge> : null}
                    <StatusBadge status={j.status} />
                  </div>
                </div>
                <div className="min-w-0 p-3">
                  <p className="line-clamp-2 break-words text-sm font-medium leading-snug">{j.title ?? j.url}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {j.channel ?? "—"} · {j.clips.length} clips · {j.clips.filter((c) => c.render.status === "done").length} rendered
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "ready") return null;
  if (status === "error") return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="warning">Working…</Badge>;
}
