"use client";
import { Fragment, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Gauge } from "@/components/gauge";
import { ImprovePanel } from "@/components/channel/improve-panel";
import { ago, num } from "@/components/channel/format";
import type { ChannelVideo } from "@/lib/types";
import { cn } from "@/lib/utils";

type Sort = "new" | "seo" | "views";

/** Every upload with its numbers and search score; Improve opens the rewrite under the row. */
export function VideosTable({ videos, canEdit, onUpdated }: { videos: ChannelVideo[]; canEdit: boolean; onUpdated: (v: ChannelVideo) => void }) {
  const [sort, setSort] = useState<Sort>("seo");
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => {
    const v = [...videos];
    if (sort === "seo") v.sort((a, b) => (a.seo ?? 0) - (b.seo ?? 0) || (b.views ?? 0) - (a.views ?? 0));
    if (sort === "views") v.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    if (sort === "new") v.sort((a, b) => b.publishedAt - a.publishedAt);
    return v;
  }, [videos, sort]);
  const hasWatch = videos.some((v) => v.avgViewPct !== undefined);

  if (!videos.length) return <p className="py-10 text-center text-sm text-muted-foreground">No uploads on this channel yet. Posted clips and stories show up here after the next refresh.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {videos.length} video{videos.length === 1 ? "" : "s"} · {videos.filter((v) => (v.seo ?? 0) < 75).length} could rank better
        </p>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Sort
          <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-auto">
            <option value="seo">Weakest search score first</option>
            <option value="views">Most views</option>
            <option value="new">Newest</option>
          </Select>
        </label>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Video</th>
              <th className="px-3 py-2.5 text-right font-medium">Views</th>
              <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Likes</th>
              {hasWatch && <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Watched</th>}
              <th className="px-3 py-2.5 text-center font-medium">SEO</th>
              <th className="px-4 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <Fragment key={v.id}>
                <tr className={cn("border-b last:border-b-0", open === v.id && "bg-accent/40")}>
                  <td className="py-2.5 pl-4 pr-2 sm:px-4">
                    <div className="flex min-w-0 items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {v.thumb ? <img src={v.thumb} alt="" className="hidden aspect-video w-20 shrink-0 rounded-md object-cover sm:block" /> : <div className="hidden aspect-video w-20 shrink-0 rounded-md bg-muted sm:block" />}
                      <div className="min-w-0">
                        <a href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium hover:underline">
                          {v.title}
                        </a>
                        <p className="text-xs text-muted-foreground">
                          {ago(v.publishedAt)}
                          {v.madeForKids ? " · made for kids" : ""}
                          {v.privacy && v.privacy !== "public" ? ` · ${v.privacy}` : ""}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(v.views)}</td>
                  <td className="hidden px-3 py-2.5 text-right tabular-nums sm:table-cell">{num(v.likes)}</td>
                  {hasWatch && <td className="hidden px-3 py-2.5 text-right tabular-nums md:table-cell">{v.avgViewPct !== undefined ? `${Math.round(v.avgViewPct)}%` : "—"}</td>}
                  <td className="px-3 py-2.5">
                    <Gauge value={v.seo} label="SEO" size="sm" className="mx-auto" />
                  </td>
                  <td className="py-2.5 pl-1 pr-3 text-right sm:px-4">
                    <Button size="sm" variant={open === v.id ? "secondary" : "outline"} onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}>
                      <Sparkles /> <span className="max-sm:sr-only">Improve</span>
                    </Button>
                  </td>
                </tr>
                {open === v.id && (
                  <tr className="border-b bg-accent/20 last:border-b-0">
                    <td colSpan={hasWatch ? 6 : 5}>
                      <ImprovePanel video={v} canEdit={canEdit} onUpdated={onUpdated} onClose={() => setOpen(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
