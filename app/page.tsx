import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { UrlForm } from "@/components/url-form";
import { jobs } from "@/server/jobs";
import { fmtTime, ytThumb } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function Home() {
  const m = jobs();
  await m.init();
  const list = m.list();

  return (
    <div className="space-y-12">
      <section className="mx-auto max-w-3xl pt-10 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/capy-logo.png" alt="capy" className="mx-auto mb-2 h-44 w-auto drop-shadow-sm" />
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">Long video in. Shorts out.</h1>
        <p className="mt-3 text-pretty text-muted-foreground">Paste a YouTube link. Claude finds the moments, you tweak them, capy renders captioned 9:16 clips on your Mac.</p>
        <div className="mt-8">
          <UrlForm large />
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-lg font-semibold">Your videos</h2>
          <span className="text-sm text-muted-foreground">{list.length} total</span>
        </div>
        {list.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed py-20 text-center text-muted-foreground">
            <Clapperboard className="mb-3 size-8 opacity-50" />
            <p>Nothing yet. Paste a link above to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {list.map((j) => (
              <Link key={j.id} href={`/v/${j.id}`} className="group overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/50">
                <div className="relative aspect-video bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ytThumb(j.videoId)} alt="" className="size-full object-cover transition-transform group-hover:scale-[1.02]" />
                  <div className="absolute bottom-2 right-2 flex gap-1">
                    {j.duration ? <Badge variant="secondary">{fmtTime(j.duration)}</Badge> : null}
                    <StatusBadge status={j.status} />
                  </div>
                </div>
                <div className="p-3">
                  <p className="line-clamp-2 text-sm font-medium leading-snug">{j.title ?? j.url}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
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
