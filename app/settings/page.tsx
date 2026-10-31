import type { Metadata } from "next";
import { AutomationSettings } from "@/components/automation-settings";
import { SettingsView } from "@/components/settings-view";
import { SettingsForm } from "@/components/settings-form";
import { SetupCheck } from "@/components/setup-check";
import { AccountsPanel } from "@/components/accounts-panel";
import { OUTPUT_ROOT } from "@/server/paths";
import { loadSettings, redact, settingsFile } from "@/server/settings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings · capy" };

export default async function SettingsPage() {
  const initial = redact(loadSettings());
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Preferences for this computer. They apply to every video.</p>
      </div>
      <AutomationSettings />
      <AccountsPanel initial={initial} />
      <SettingsView initialSettings={initial} />
      <SettingsForm initial={initial} meta={{ file: settingsFile(), outputRoot: OUTPUT_ROOT }} />
      <SetupCheck lastCheckedAt={initial.checkedAt} />
    </div>
  );
}
