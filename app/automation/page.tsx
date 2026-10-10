import type { Metadata } from "next";
import { AutomationView } from "@/components/automation-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Monitor · capy" };

export default function AutomationPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <AutomationView />
    </div>
  );
}
