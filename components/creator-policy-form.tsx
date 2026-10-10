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
        Creator recipe and capacity
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Recipes retain immutable versions. Automatic publishing is unavailable
          until the worker fault soak and controlled upload are verified.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="text-xs">
            Automation mode
            <Select
              aria-label="Automation mode"
              value={value.mode}
              onChange={(e) =>
                setValue({
                  ...value,
                  mode: e.target.value as CreatorPolicy["mode"],
                })
              }
            >
              <option value="disabled">Disabled</option>
              <option value="manual">Manual imports</option>
              <option value="automatic_drafts">Automatic drafts</option>
              <option value="automatic_publish" disabled>
                Automatic publish · release proof required
              </option>
            </Select>
          </label>
          <label className="text-xs">
            Edit template
            <Select
              aria-label="Edit template"
              value={value.editTemplate}
              onChange={(e) =>
                setValue({
                  ...value,
                  editTemplate: e.target.value as CreatorPolicy["editTemplate"],
                })
              }
            >
              <option value="bold-portrait-v1">Bold portrait v1</option>
              <option value="clean-portrait-v1">Clean portrait v1</option>
            </Select>
          </label>
          {number("maxJobUsd", "AI job budget USD", 0, 100)}
          {number("maxDayUsd", "AI daily budget USD", 0, 1000)}
          {number("maxBlackRatio", "Maximum black-frame fraction", 0, 1)}
          {number("maxFrozenRatio", "Maximum frozen-frame fraction", 0, 1)}
          {number("clips", "Recipe clips per source", 1, 8)}
          {number("dailyClipCap", "Daily automated clip limit", 1, 100)}
          {number("destinationDailySlots", "Destination slots per day", 1, 100)}
          {number("targetQueueDays", "Target queue days", 1, 7)}
          {number("maxBacklogDays", "Maximum backlog days", 1, 30)}
          {number("freshnessHours", "Freshness hours", 1, 8760)}
          {number("minDurationSec", "Minimum source seconds", 0, 86400)}
          {number("maxDurationSec", "Maximum source seconds", 1, 86400)}
          <label className="text-xs">
            Caption language
            <Input
              aria-label="Caption language"
              value={value.language}
              onChange={(e) => setValue({ ...value, language: e.target.value })}
            />
          </label>
          <label className="text-xs">
            Thumbnail generation
            <Select
              aria-label="Thumbnail generation"
              value={value.thumbnailGeneration}
              onChange={(e) =>
                setValue({
                  ...value,
                  thumbnailGeneration: e.target
                    .value as CreatorPolicy["thumbnailGeneration"],
                })
              }
            >
              <option value="manual">Manual</option>
              <option value="automatic">
                Automatic local designs after final render
              </option>
            </Select>
          </label>
          <label className="text-xs">
            Optional thumbnail fallback
            <Select
              aria-label="Optional thumbnail fallback"
              value={value.optionalThumbnailFallback}
              onChange={(e) =>
                setValue({
                  ...value,
                  optionalThumbnailFallback: e.target
                    .value as CreatorPolicy["optionalThumbnailFallback"],
                })
              }
            >
              <option value="none">No thumbnail</option>
              <option value="source_frame">
                Exact source frame · attach before posting
              </option>
            </Select>
          </label>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Include title topics (comma separated)
            <Input
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
            Exclude title topics (comma separated)
            <Input
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
          <legend className="mb-1 text-xs">Permitted reading methods</legend>
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
                ? "Connected reading account · complete uploads"
                : "Account-free Videos tab · incomplete format coverage"}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs">Publishing destinations</legend>
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
              Connect a publishing account to configure calendar capacity.
            </p>
          )}
        </fieldset>
        {toggle("allowArchives", "Allow finished stream archives")}
        {toggle(
          "allowShortSources",
          "Allow sources of 180 seconds or less (duration rule)",
        )}
        {toggle(
          "expireFreshness",
          "Explicitly expire sources outside freshness window",
        )}
        {toggle(
          "requireAudio",
          "Require audible audio (silent footage otherwise allowed)",
        )}
        {toggle(
          "requireModelReview",
          "Require supplementary content review before publishing",
        )}
        {toggle(
          "thumbnailRequired",
          "Require an approved current thumbnail version",
        )}
        {value.recipeId && (
          <p className="break-all text-xs text-muted-foreground">
            Saved recipe version: {value.recipeId.slice(0, 12)}
          </p>
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
          Save creator recipe
        </Button>
      </div>
    </details>
  );
}
