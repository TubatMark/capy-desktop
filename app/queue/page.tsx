import type { Metadata } from "next";
import { QueueView } from "@/components/queue-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Queue · capy" };

export default function QueuePage() {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <QueueView />
    </div>
  );
}
