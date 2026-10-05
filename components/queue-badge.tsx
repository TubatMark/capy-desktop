"use client";
import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { NavLink } from "@/components/nav-link";

/** Header link to the posting queue, with the number of clips waiting for review. */
export function QueueBadge() {
  const [review, setReview] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/queue/summary")
        .then((r) => r.json())
        .then((s) => live && setReview(s.review ?? 0))
        .catch(() => {});
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return (
    <NavLink href="/queue" label={review ? `Queue: ${review} waiting for review` : "Queue"} className="relative rounded-md p-2 hover:bg-accent">
      <CalendarClock className="size-5" />
      {review > 0 && <span className="absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">{review}</span>}
    </NavLink>
  );
}
