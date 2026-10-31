import type { Metadata } from "next";
import { QueueView } from "@/components/queue-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Short form · capy" };

export default function ShortFormPage() {
  return (
    <div className="mx-auto w-full max-w-7xl">
      <QueueView />
    </div>
  );
}
