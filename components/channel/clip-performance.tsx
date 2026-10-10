"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { api } from "@/hooks/use-job";
import type {
  MetricObservation,
  MetricsRefresh,
  PerformancePublication,
} from "@/lib/performance";
const reasons: Record<string, string> = {
  "not-published": "No confirmed remote publication ID yet",
  "not-supported": "This platform needs a separate metrics milestone",
  "scope-missing": "Analytics permission is unavailable",
  "delayed-or-limited": "Analytics is delayed or limited",
  "not-returned": "This value was not returned",
  "auth-required": "Reconnect to refresh",
  quota: "API quota is unavailable",
  "request-failed": "Refresh failed",
  "invalid-response": "Provider data could not be verified",
  "destination-changed": "The publishing destination changed",
  expired: "Cached results expired",
  "not-refreshed": "Not refreshed yet",
};
const at = (value: number) => new Date(value).toLocaleString();
function Metric({ value, label }: { value: MetricObservation; label: string }) {
  const old =
    value.availability === "unavailable" ? value.lastAvailable : undefined;
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg tabular-nums">
        {value.availability === "available"
          ? `${value.value.toLocaleString()}${value.unit === "percent" ? "%" : ""}`
          : "—"}
      </p>
      {value.availability === "available" ? (
        <p className="text-xs text-muted-foreground">
          YouTube · measured {at(value.measuredAt)}
          <br />
          {value.window.kind === "lifetime"
            ? "Lifetime total"
            : `${value.window.startDay} to requested ${value.window.requestedEndDay} · Pacific days; returned coverage ${value.window.coverage}`}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {reasons[value.reason] ?? value.reason}
          {old && (
            <>
              <br />
              Last available: {old.value.toLocaleString()}
              {old.unit === "percent" ? "%" : ""} · {at(old.measuredAt)}
            </>
          )}
        </p>
      )}
    </div>
  );
}
function Publication({
  row,
  onChange,
}: {
  row: PerformancePublication;
  onChange: (id: string) => void;
}) {
  const a = row.attribution,
    recipe = a.recipe,
    source = a.source;
  const editor = source.projectId
    ? `/studio/${encodeURIComponent(source.projectId)}`
    : source.jobId
      ? `/v/${encodeURIComponent(source.jobId)}${source.clipN ? `/clip/${source.clipN}` : ""}`
      : undefined;
  return (
    <article
      className="space-y-3 rounded-xl border bg-card p-4"
      aria-label={`Publication ${row.remoteId ?? row.delivery.id}`}
    >
      <div className="flex flex-wrap justify-between gap-2">
        <div>
          <h3 className="font-medium">
            {row.remoteId ? (
              <Link
                href={`https://www.youtube.com/watch?v=${encodeURIComponent(row.remoteId)}`}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                YouTube {row.remoteId}
              </Link>
            ) : (
              "Awaiting publication identity"
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            Delivery {row.delivery.state} · remote visibility{" "}
            {row.delivery.visibility}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          Package {a.packageHash.slice(0, 12)} · artifact {a.artifact.id}
          {a.artifact.revision !== undefined
            ? ` · revision ${a.artifact.revision}`
            : ""}
        </span>
      </div>
      <p className="text-sm">
        {recipe.state === "attributed"
          ? `Recipe ${recipe.recipeId.slice(0, 12)} · ${recipe.definition.editTemplate}`
          : `${recipe.state === "manual" ? "Manual edit" : "Recipe unattributed"}: ${recipe.reason}`}
        {source.creatorId ? ` · creator ${source.creatorId}` : ""}
        {source.videoId ? ` · source ${source.videoId}` : ""}
        {a.outputDurationUs
          ? ` · rendered ${(a.outputDurationUs / 1e6).toFixed(2)}s`
          : ""}
      </p>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Metric label="Views · lifetime" value={row.metrics.views} />
        <Metric
          label="Views · analytics interval"
          value={row.metrics.analyticsViews}
        />
        <Metric
          label="Engaged views · analytics interval"
          value={row.metrics.engagedViews}
        />
        <Metric
          label="Average watched · YouTube percentage"
          value={row.metrics.averageViewPercentage}
        />
        <Metric
          label="Average view duration · seconds"
          value={row.metrics.averageViewDuration}
        />
        <Metric
          label="Watch time · minutes"
          value={row.metrics.estimatedMinutesWatched}
        />
        <Metric label="Likes · lifetime" value={row.metrics.likes} />
        <Metric label="Comments · lifetime" value={row.metrics.comments} />
      </div>
      <div className="text-xs text-muted-foreground">
        <p>
          Selected thumbnail:{" "}
          {a.thumbnail
            ? `${a.thumbnail.designId ?? "source frame"} · version ${a.thumbnail.versionId ?? a.thumbnail.revision}`
            : "none"}{" "}
          · attachment {row.delivery.thumbnail.status}
          {row.delivery.thumbnail.observedAt
            ? ` at ${at(row.delivery.thumbnail.observedAt)}`
            : ""}
          .
        </p>
        <p>
          {row.thumbnailAttribution === "uncertain"
            ? "Remote change reported; thumbnail exposure and affected measurement intervals are uncertain."
            : "Attachment acceptance does not verify the displayed thumbnail on every surface or later remote changes."}
        </p>
        {row.remoteChanges.map((change, i) => (
          <p key={i}>
            {change.kind} change reported {at(change.reportedAt)} ·{" "}
            {change.changedAt
              ? `change time ${at(change.changedAt)}`
              : "exact change time unknown"}
          </p>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {editor && (
          <Button asChild variant="outline" size="sm">
            <Link href={editor}>Review clip length locally</Link>
          </Button>
        )}
        {row.remoteId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange(row.remoteId!)}
          >
            Thumbnail changed on YouTube
          </Button>
        )}
      </div>
    </article>
  );
}
export function ClipPerformance() {
  const [data, setData] = useState<MetricsRefresh | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<MetricsRefresh>("/api/channel/performance"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const action = async (method: "POST" | "DELETE", body?: unknown) => {
    setBusy(true);
    try {
      setData(
        await api<MetricsRefresh>("/api/channel/performance", {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Clip results" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Clip results</h2>
          <p className="text-sm text-muted-foreground">
            Exact published packages and raw YouTube metrics. Missing data is
            unavailable, not zero.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void action("POST", { action: "refresh" })}
          >
            Refresh clip results
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void action("DELETE")}
          >
            Delete cached results
          </Button>
        </div>
      </header>
      <p className="text-xs text-muted-foreground">
        Deleting cached results preserves local media and publishing history,
        and does not delete YouTube posts. Analytics can arrive later than view
        totals. Non-random results do not prove a recipe or thumbnail caused an
        improvement.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {data?.reason && (
        <p className="text-sm text-muted-foreground">{data.reason}</p>
      )}
      {data?.continuation && (
        <p className="text-xs text-muted-foreground">
          More exact publications remain; refresh continues with the oldest
          unchecked results.
        </p>
      )}
      {data?.publications.map((row) => (
        <Publication
          key={row.key}
          row={row}
          onChange={(id) =>
            void action("POST", {
              action: "remote-change",
              remoteId: id,
              kind: "thumbnail",
            })
          }
        />
      ))}
      {data && !data.publications.length && (
        <p className="text-sm text-muted-foreground">
          No durable publication identities are recorded for this destination
          yet. Historical results without exact proof are not assigned to a
          recipe.
        </p>
      )}
      <div className="space-y-2 rounded-lg border p-4">
        <p className="font-medium text-sm">
          Capy suggestions · local editing options
        </p>
        <p className="text-xs text-muted-foreground">
          Performance improvement is unproven. Choose a creator, review your own
          topic filters, cut length locally, or try a supported template in a
          recipe draft. Changes require your explicit save.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link href="/automation">
            Review creator, topic and template recipes
          </Link>
        </Button>
      </div>
    </section>
  );
}
