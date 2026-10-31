"use client";
import { useState } from "react";
import Link from "next/link";
import { Clapperboard, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { filterLibrary, type LibraryVideo } from "@/lib/library";
import { fmtTime, ytThumb } from "@/lib/utils";

/** Enough to scroll through without hundreds of thumbnails slowing the page. */
const PAGE = 24;

/** The videos capy has worked on, newest first. */
export function LibraryGrid({ videos }: { videos: LibraryVideo[] }) {
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  const found = filterLibrary(videos, search);
  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Your videos</h2>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
          {videos.length > 0 && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search your videos"
                placeholder="Search by title or channel"
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setShown(PAGE);
                }}
              />
            </div>
          )}
          <span className="shrink-0 text-sm text-muted-foreground">{search.trim() ? `${found.length} of ${videos.length}` : `${videos.length} total`}</span>
        </div>
      </div>
      {videos.length === 0 ? (
        <div className="grid place-items-center rounded-xl border border-dashed px-4 py-16 text-center text-muted-foreground sm:py-20">
          <Clapperboard className="mb-3 size-8 opacity-50" />
          <p>Nothing yet. Paste a link above to get started.</p>
        </div>
      ) : found.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No videos match that search.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {found.slice(0, shown).map((j) => (
            <Link key={j.id} href={`/v/${j.id}`} className="group min-w-0 overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/50">
              <div className="relative aspect-video bg-black">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ytThumb(j.videoId)} alt="" loading="lazy" className="size-full object-cover transition-transform group-hover:scale-[1.02]" />
                <div className="absolute bottom-2 right-2 flex gap-1">
                  {j.duration ? <Badge variant="secondary">{fmtTime(j.duration)}</Badge> : null}
                  <StatusBadge status={j.status} />
                </div>
              </div>
              <div className="min-w-0 p-3">
                <p className="line-clamp-2 break-words text-sm font-medium leading-snug">{j.title}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {j.channel ?? "—"} · {j.clips} clips · {j.rendered} rendered
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
      {found.length > shown && (
        <div className="text-center">
          <button type="button" className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, found.length - shown)} more
          </button>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "ready") return null;
  if (status === "error") return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="warning">Working…</Badge>;
}
