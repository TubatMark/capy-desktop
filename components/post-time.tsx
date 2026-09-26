"use client";
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Copy, Check } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { AUDIENCES, audienceTz, bestPostTimes } from "@/lib/post-time";

const KEY = "capy.audience";

/** Best time to post this Short: next 3 slots in audience time, UTC, and your time. */
export function PostTime() {
  const [audience, setAudience] = useState<string>("us-east");
  const [now, setNow] = useState(() => new Date());
  const yourTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v) setAudience(v);
    } catch {
      /* private mode */
    }
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const slots = useMemo(() => bestPostTimes(audienceTz(audience), yourTz, now, 3), [audience, yourTz, now]);
  const best = slots[0];

  function choose(v: string) {
    setAudience(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-3 rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <CalendarClock className="size-4 text-primary" /> Best time to post
        </h2>
        <div className="w-44">
          <Select value={audience} onChange={(e) => choose(e.target.value)} aria-label="Audience">
            {AUDIENCES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {best && (
        <div className="rounded-lg border border-primary/40 bg-primary/10 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-primary">Recommended · {best.dayName}</p>
              <p className="mt-1 font-mono text-lg tabular-nums">{best.utc} UTC</p>
              <p className="text-sm text-muted-foreground">
                {best.audienceLocal} audience time · {best.yourLocal} your time
              </p>
            </div>
            <CopyBtn text={`${best.at.toISOString().slice(0, 16).replace("T", " ")} UTC`} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{best.reason}</p>
        </div>
      )}

      <div>
        <Label>Other good slots</Label>
        <ul className="mt-1.5 space-y-1 text-sm">
          {slots.slice(1).map((s) => (
            <li key={s.at.toISOString()} className="flex items-center justify-between gap-2">
              <span className="font-mono">{s.utc} UTC</span>
              <span className="text-xs text-muted-foreground">{s.audienceLocal.split(", ")[1] ?? s.audienceLocal} local</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground">
        Based on published Shorts studies (evenings 6–11pm audience-local, Fri/Thu/Sat strongest, Mon/Tue weakest); we schedule ~1h before the peak. Once your channel has data, YouTube Studio → Analytics → Audience → “When your viewers are on YouTube” beats this.
      </p>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      title="Copy as UTC for the YouTube scheduler"
    >
      {ok ? <Check className="size-3" /> : <Copy className="size-3" />} {ok ? "copied" : "copy UTC"}
    </button>
  );
}
