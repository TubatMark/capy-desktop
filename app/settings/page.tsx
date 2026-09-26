import { SettingsForm } from "@/components/settings-form";
import { SetupCheck } from "@/components/setup-check";
import { OUTPUT_ROOT } from "@/server/paths";
import { loadSettings, redact, settingsFile } from "@/server/settings";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings · capy" };

export default function SettingsPage() {
  const initial = redact(loadSettings());
  return (
    <div className="mx-auto w-full max-w-2xl space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">How capy fetches videos, which model picks the clips, and how Claude is billed.</p>
      </header>
      <SettingsForm initial={initial} meta={{ file: settingsFile(), outputRoot: OUTPUT_ROOT }} />
      <SetupCheck lastCheckedAt={initial.checkedAt} />
    </div>
  );
}
