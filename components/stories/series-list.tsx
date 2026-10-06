"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/hooks/use-job";
import type { AgeBand, StorySeries } from "@/lib/types";

/** Drawing styles offered for a new series (the text goes into every illustration prompt). */
export const ART_STYLES = [
  { id: "pastel", label: "Soft pastel", style: "soft pastel colours (peach, mint, butter yellow, sky blue), cosy and calm" },
  { id: "bright", label: "Bright & bold", style: "bright cheerful primary colours with lots of contrast, playful" },
  { id: "autumn", label: "Cosy autumn", style: "warm autumn palette (orange, rust, mustard, olive), snug and homey" },
  { id: "night", label: "Bedtime blues", style: "deep night blues and purples with warm glowing lights, dreamy and sleepy" },
];

export function SeriesList() {
  const router = useRouter();
  const [list, setList] = useState<StorySeries[] | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [ageBand, setAgeBand] = useState<AgeBand>("2-4");
  const [tone, setTone] = useState("gentle and funny, with calm happy endings");
  const [values, setValues] = useState("kindness, sharing, trying new things");
  const [art, setArt] = useState(ART_STYLES[0]!.id);
  const [chars, setChars] = useState([{ name: "", description: "" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ series: StorySeries[] }>("/api/stories")
      .then((r) => {
        setList(r.series);
        if (!r.series.length) setOpen(true);
      })
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const s = await api<StorySeries>("/api/stories", {
        method: "POST",
        body: JSON.stringify({
          title,
          ageBand,
          tone,
          values: values.split(",").map((v) => v.trim()).filter(Boolean),
          artStyle: ART_STYLES.find((a) => a.id === art)!.style,
          characters: chars.filter((c) => c.name.trim()),
        }),
      });
      router.push(`/stories/${s.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <BookOpen className="size-6 text-primary" /> Stories
          </h1>
          <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
            Original read-aloud picture books for kids. AI writes each story, a kid-safety reviewer checks it, AI draws the pages with your series&apos; characters, and
            the computer&apos;s own voices narrate it with read-along captions. Finished stories wait in Queue for your OK like any clip.
          </p>
        </div>
        {!open && (
          <Button onClick={() => setOpen(true)}>
            <Plus /> New series
          </Button>
        )}
      </div>

      {open && (
        <form onSubmit={create} className="space-y-5 rounded-xl border bg-card p-5">
          <div>
            <h2 className="font-semibold">New series</h2>
            <p className="text-sm text-muted-foreground">A series keeps the same characters, age group and look across all its stories.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Series name">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pip & Lulu's Snowy Days" required />
            </Field>
            <Field label="For ages">
              <Select value={ageBand} onChange={(e) => setAgeBand(e.target.value as AgeBand)}>
                <option value="2-4">2–4 (very short pages, a little repetition)</option>
                <option value="5-8">5–8 (a small problem solved, gentle humour)</option>
              </Select>
            </Field>
            <Field label="Tone">
              <Input value={tone} onChange={(e) => setTone(e.target.value)} />
            </Field>
            <Field label="What the stories teach (comma separated)">
              <Input value={values} onChange={(e) => setValues(e.target.value)} />
            </Field>
            <Field label="Look">
              <Select value={art} onChange={(e) => setArt(e.target.value)}>
                {ART_STYLES.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="space-y-2">
            <Label>Characters</Label>
            <p className="text-xs text-muted-foreground">Describe how each one looks; they&apos;re drawn once and appear the same in every story.</p>
            {chars.map((c, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
                <Input value={c.name} onChange={(e) => setChars(chars.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} placeholder="Pip" aria-label="Character name" />
                <Textarea
                  rows={1}
                  value={c.description}
                  onChange={(e) => setChars(chars.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))}
                  placeholder="a small round penguin with a bright orange scarf and big friendly eyes"
                  aria-label="What they look like"
                />
                <Button type="button" variant="ghost" size="sm" disabled={chars.length === 1} onClick={() => setChars(chars.filter((_, k) => k !== i))} aria-label="Remove character">
                  <Trash2 />
                </Button>
              </div>
            ))}
            {chars.length < 6 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setChars([...chars, { name: "", description: "" }])}>
                <Plus /> Add a character
              </Button>
            )}
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !title.trim() || !chars.some((c) => c.name.trim() && c.description.trim().length >= 3)}>
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Create series and draw the characters
            </Button>
            {!!list?.length && (
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

      {list === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : (
        list.length > 0 && (
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((s) => (
              <Link key={s.id} href={`/stories/${s.id}`} className="group space-y-3 rounded-xl border bg-card p-4 transition-shadow hover:shadow-[0_6px_20px_-8px_oklch(0.24_0.03_45_/_30%)]">
                <div className="flex -space-x-3">
                  {s.characters.map((c) =>
                    c.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={c.id} src={c.imageUrl} alt={c.name} className="size-14 rounded-full border-2 border-card bg-background object-cover" />
                    ) : (
                      <div key={c.id} className="grid size-14 place-items-center rounded-full border-2 border-card bg-muted text-xs text-muted-foreground">
                        {c.name.slice(0, 1)}
                      </div>
                    ),
                  )}
                </div>
                <div>
                  <p className="font-semibold group-hover:underline">{s.title}</p>
                  <p className="text-xs text-muted-foreground">
                    Ages {s.ageBand} · {s.characters.map((c) => c.name).join(", ")}
                  </p>
                </div>
              </Link>
            ))}
          </section>
        )
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
