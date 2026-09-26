"use client";
import { useEffect, useRef } from "react";

/**
 * YouTube IFrame embed. `seekTo` (seconds) reloads the player at that time;
 * uses the postMessage API when the player is already loaded so it doesn't flash.
 */
export function YouTubeEmbed({ videoId, seekTo, className = "" }: { videoId: string; seekTo?: number; className?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const last = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (seekTo === undefined || seekTo === last.current) return;
    last.current = seekTo;
    ref.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "seekTo", args: [Math.floor(seekTo), true] }), "*");
    ref.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "playVideo", args: [] }), "*");
  }, [seekTo]);

  const start = Math.floor(seekTo ?? 0);
  return (
    <div className={`relative aspect-video overflow-hidden rounded-xl bg-black ${className}`}>
      <iframe
        ref={ref}
        className="absolute inset-0 size-full"
        src={`https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&start=${start}&rel=0&modestbranding=1`}
        title="YouTube video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
