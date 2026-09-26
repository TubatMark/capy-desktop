import type { Metadata } from "next";
import { SettingsView } from "@/components/settings-view";
import { detectAgents } from "@/src/agents";
import { loadAppSettings } from "@/server/settings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings · capy" };

export default async function SettingsPage() {
  const [settings, agents] = await Promise.all([loadAppSettings(), detectAgents()]);
  return <SettingsView initialSettings={settings} initialAgents={agents} />;
}
