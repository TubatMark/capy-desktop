import type { Metadata } from "next";
import { SettingsView } from "@/components/settings-view";
import { SettingsForm } from "@/components/settings-form";
import { SetupCheck } from "@/components/setup-check";
import { detectAgents } from "@/src/agents";
import { OUTPUT_ROOT } from "@/server/paths";
import { loadSettings, redact, settingsFile } from "@/server/settings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings · capy" };

export default async function SettingsPage() {
  const initial = redact(loadSettings());
  const agents = await detectAgents();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <SettingsView initialSettings={initial} initialAgents={agents} />
      <SettingsForm initial={initial} meta={{ file: settingsFile(), outputRoot: OUTPUT_ROOT }} />
      <SetupCheck lastCheckedAt={initial.checkedAt} />
    </div>
  );
}
