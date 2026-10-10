"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/hooks/use-job";
import type { ProjectDocument } from "@/lib/studio/types";
type Source = {
  id: string;
  title: string;
  duration?: number;
  clips: { n: number; title: string; start: number; end: number }[];
};
export function ProjectList() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectDocument[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [jobId, setJobId] = useState("");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(10);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([
      api<ProjectDocument[]>("/api/studio/projects"),
      api<Source[]>("/api/studio/sources"),
    ])
      .then(([p, s]) => {
        setProjects(p);
        setSources(s);
      })
      .catch((e) => setError(e.message));
  }, []);
  async function create(mode: "blank" | "merge" | "range") {
    setBusy(true);
    setError("");
    try {
      const chosen =
        mode === "range"
          ? [
              {
                jobId,
                startUs: Math.round(start * 1000000),
                endUs: Math.round(end * 1000000),
              },
            ]
          : mode === "merge"
            ? selected.map((key) => {
                const [jobId, n] = key.split(":");
                return { jobId, clipN: Number(n) };
              })
            : [];
      const project = await api<ProjectDocument>("/api/studio/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || undefined,
          sources: chosen,
        }),
      });
      router.push(`/studio/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Studio</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build a new edit from your clips or local media.
          </p>
        </div>
        <Button disabled={busy} onClick={() => void create("blank")}>
          <Plus />
          New project
        </Button>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Start from source clips</h2>
        <Input
          aria-label="New project name"
          placeholder="Project name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mb-4 max-w-sm"
        />
        {sources.length ? (
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-3">
              <div className="max-h-64 space-y-4 overflow-auto">
                {sources.map((source) => (
                  <fieldset key={source.id}>
                    <legend className="mb-2 truncate text-sm font-medium">
                      {source.title}
                    </legend>
                    {source.clips.map((clip) => {
                      const key = `${source.id}:${clip.n}`;
                      return (
                        <label
                          key={key}
                          className="flex items-center gap-3 rounded-md p-2 text-xs hover:bg-accent"
                        >
                          <input
                            type="checkbox"
                            checked={selected.includes(key)}
                            onChange={(e) =>
                              setSelected((s) =>
                                e.target.checked
                                  ? [...s, key]
                                  : s.filter((k) => k !== key),
                              )
                            }
                          />
                          <span className="min-w-0 truncate">
                            {clip.title} · {clip.start.toFixed(1)}–
                            {clip.end.toFixed(1)}s
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
              <Button
                variant="outline"
                disabled={!selected.length || busy}
                onClick={() => void create("merge")}
              >
                <Layers />
                Merge {selected.length} clips into new project
              </Button>
            </div>
            <div className="space-y-3">
              <h3 className="text-xs font-semibold">Choose any source range</h3>
              <select
                aria-label="Source video"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                className="w-full rounded-md border bg-background p-2 text-sm"
              >
                <option value="">Choose a video</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">
                  From (seconds)
                  <Input
                    aria-label="Source range start"
                    type="number"
                    min="0"
                    step="0.01"
                    value={start}
                    onChange={(e) => setStart(Number(e.target.value))}
                  />
                </label>
                <label className="text-xs">
                  To (seconds)
                  <Input
                    aria-label="Source range end"
                    type="number"
                    min="0"
                    step="0.01"
                    value={end}
                    onChange={(e) => setEnd(Number(e.target.value))}
                  />
                </label>
              </div>
              <Button
                variant="outline"
                disabled={!jobId || busy}
                onClick={() => void create("range")}
              >
                Create from range
              </Button>
              <p className="text-xs text-muted-foreground">
                The worker fetches exactly this footage, including ranges
                outside cached clips. Preparation status appears in your
                project.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Your analyzed videos will appear here. Start a new project to import
            local media.
          </p>
        )}
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold">Your projects</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/studio/${project.id}`}
              className="rounded-xl border bg-card p-5 transition-colors hover:bg-accent"
            >
              <p className="font-medium">
                {project.name ?? "Untitled project"}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {project.items.length} clips · Revision {project.revision}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {project.updatedAt
                  ? new Date(project.updatedAt).toLocaleString()
                  : ""}
              </p>
            </Link>
          ))}
        </div>
        {!projects.length && (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Your saved projects will appear here.
          </p>
        )}
      </section>
    </div>
  );
}
