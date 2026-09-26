"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppSettings } from "@/lib/types";

const KEY = "capy.setupBannerDismissed";

/**
 * Home-page nudge to run the setup check (Settings → Setup check) until it has been run once
 * (`AppSettings.checkedAt`). Dismissal is remembered in localStorage. Renders nothing while
 * loading, when the settings route is unavailable, or after the check has run.
 */
export function SetupBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "1") return;
    } catch {
      /* private mode */
    }
    let alive = true;
    fetch("/api/settings")
      .then(async (r) => {
        if (!alive || !r.ok) return;
        const { settings } = (await r.json()) as { settings?: Partial<AppSettings> };
        if (!settings?.checkedAt) setShow(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  function dismiss() {
    setShow(false);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
  }

  if (!show) return null;
  return (
    <div role="status" className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-primary/10 p-3 pl-4 text-sm sm:flex-nowrap">
      <Wrench className="size-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 text-pretty">Run the setup check to make sure ffmpeg, yt-dlp and Claude are ready.</p>
      <div className="ml-auto flex items-center gap-1">
        <Button size="sm" asChild>
          <Link href="/settings">Open settings</Link>
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={dismiss} aria-label="Dismiss">
          <X />
        </Button>
      </div>
    </div>
  );
}
