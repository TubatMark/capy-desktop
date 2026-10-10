"use client";
import { useState } from "react";
import type { CreatorPolicy, AutomationHealth } from "@/lib/creator-policy";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { api } from "@/hooks/use-job";
export function CreatorPolicyForm({
  channelId,
  policy,
  accounts,
  onSaved,
}: {
  channelId: string;
  policy: CreatorPolicy;
  accounts: AutomationHealth["accounts"];
  onSaved: () => void;
}) {
  const [value, setValue] = useState(policy),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const number = (
    key: keyof CreatorPolicy,
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="flex flex-col gap-1 text-xs">
      {label}
      <Input
        aria-label={label}
        type="number"
        step="any"
        min={min}
        max={max}
        value={value[key] as number}
        onChange={(e) => setValue({ ...value, [key]: Number(e.target.value) })}
      />
    </label>
  );
  const toggle = (
    key:
      | "expireFreshness"
      | "requireAudio"
      | "requireModelReview"
      | "thumbnailRequired"
      | "allowArchives"
      | "allowShortSources",
    label: string,
  ) => (
    <label className="flex gap-2 text-sm">
      <input
        type="checkbox"
        checked={value[key]}
        onChange={(e) => setValue({ ...value, [key]: e.target.checked })}
      />
      {label}
    </label>
  );
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        More options
      </summary>
      <div className="mt-3 space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="text-xs">
            New videos
            <Select
              aria-label="New videos"
              value={value.mode}
              onChange={(e) =>
                setValue({
                  ...value,
                  mode: e.target.value as CreatorPolicy["mode"],
                })
              }
            >
              <option value="disabled">Ignore them</option>
              <option value="manual">Only when I ask</option>
              <option value="automatic_drafts">Make clips automatically</option>
              <option value="automatic_publish" disabled>
                Post automatically (coming later)
              </option>
            </Select>
          </label>
          <label className="text-xs">
            Caption style
            <Select
              aria-label="Caption style"
              value={value.editTemplate}
              onChange={(e) =>
                setValue({
                  ...value,
                  editTemplate: e.target.value as CreatorPolicy["editTemplate"],
                })
              }
            >
              <option value="bold-portrait-v1">Bold</option>
              <option value="clean-portrait-v1">Clean</option>
            </Select>
          </label>
          {number("dailyClipCap", "Most clips a day", 1, 100)}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Only videos whose title mentions
            <Input
              placeholder="e.g. podcast, interview (blank = any)"
              value={value.includeTopics.join(", ")}
              onChange={(e) =>
                setValue({
                  ...value,
                  includeTopics: e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label className="text-xs">
            Skip videos whose title mentions
            <Input
              placeholder="e.g. sponsored, trailer"
              value={value.excludeTopics.join(", ")}
              onChange={(e) =>
                setValue({
                  ...value,
                  excludeTopics: e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs">Post to</legend>
          {accounts
            .filter((a) => a.id && a.connected && !a.needsReconnect)
            .map((a) => (
              <label key={a.platform} className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value.destinationAccountIds.includes(a.id!)}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      destinationAccountIds: e.target.checked
                        ? [...value.destinationAccountIds, a.id!]
                        : value.destinationAccountIds.filter(
                            (id) => id !== a.id,
                          ),
                    })
                  }
                />
                {a.platform} · {a.id}
              </label>
            ))}
          {!accounts.some((a) => a.id && a.connected) && (
            <p className="text-xs text-muted-foreground">
              Connect an account in Settings to choose where clips go.
            </p>
          )}
        </fieldset>
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-xs font-medium">
            Advanced
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {number("maxDurationSec", "Skip videos longer than (seconds)", 1, 86400)}
              {number("freshnessHours", "Skip videos older than (hours)", 1, 8760)}
              {number("destinationDailySlots", "Posts a day per account", 1, 100)}
              {number("targetQueueDays", "Days of posts to keep ready", 1, 7)}
              {number("maxBacklogDays", "Stop once this many days are queued", 1, 30)}
              {number("maxJobUsd", "Most AI spend per video ($)", 0, 100)}
              {number("maxDayUsd", "Most AI spend per day ($)", 0, 1000)}
              {number("maxBlackRatio", "Skip if this share is black (0–1)", 0, 1)}
              {number("maxFrozenRatio", "Skip if this share is frozen (0–1)", 0, 1)}
              <label className="text-xs">
                Caption language code
                <Input
                  aria-label="Caption language code"
                  placeholder="blank = automatic"
                  value={value.language}
                  onChange={(e) => setValue({ ...value, language: e.target.value })}
                />
              </label>
              <label className="text-xs">
                Thumbnails
                <Select
                  aria-label="Thumbnails"
                  value={value.thumbnailGeneration}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      thumbnailGeneration: e.target
                        .value as CreatorPolicy["thumbnailGeneration"],
                    })
                  }
                >
                  <option value="manual">I&apos;ll make them</option>
                  <option value="automatic">Make them automatically</option>
                </Select>
              </label>
              <label className="text-xs">
                If a clip has no thumbnail
                <Select
                  aria-label="If a clip has no thumbnail"
                  value={value.optionalThumbnailFallback}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      optionalThumbnailFallback: e.target
                        .value as CreatorPolicy["optionalThumbnailFallback"],
                    })
                  }
                >
                  <option value="none">Post without one</option>
                  <option value="source_frame">Use a frame from the video</option>
                </Select>
              </label>
            </div>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-xs">How capy finds new videos</legend>
              {(["uploads-playlist", "videos-tab"] as const).map((method) => (
                <label key={method} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={value.sourceMethods.includes(method)}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        sourceMethods: e.target.checked
                          ? [...value.sourceMethods, method]
                          : value.sourceMethods.filter((m) => m !== method),
                      })
                    }
                  />
                  {method === "uploads-playlist"
                    ? "Through your YouTube account (sees everything, including Shorts and live replays)"
                    : "Without an account (regular videos only)"}
                </label>
              ))}
            </fieldset>
            {toggle("allowArchives", "Use replays of live streams")}
            {toggle("allowShortSources", "Use videos 3 minutes or shorter")}
            {toggle("expireFreshness", "Drop videos that get too old while waiting")}
            {toggle("requireAudio", "Skip videos with no sound")}
            {toggle("requireModelReview", "Have AI double-check clips before they reach Queue")}
            {toggle("thumbnailRequired", "Don't post a clip until its thumbnail is approved")}
          </div>
        </details>
        {value.recipeId && (
          <p className="text-xs text-muted-foreground">Saved.</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <Button
          size="sm"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await api("/api/automation/health", {
                method: "PUT",
                body: JSON.stringify({ channelId, policy: value }),
              });
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save options
        </Button>
      </div>
    </details>
  );
}
