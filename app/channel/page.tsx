import type { Metadata } from "next";
import { ChannelView } from "@/components/channel/channel-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard · capy" };

export default function ChannelPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <ChannelView />
    </div>
  );
}
