"use client";
import { useEffect, useRef, useState } from "react";
import type { AssetRef } from "@/lib/studio/types";
/** Encode a local recording as PCM WAV for the existing asset import contract. */
async function wav(blob: Blob) {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const count = audio.length,
      channels = Math.min(2, audio.numberOfChannels),
      out = new ArrayBuffer(44 + count * channels * 2),
      view = new DataView(out);
    const text = (at: number, s: string) =>
      [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + count * channels * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, audio.sampleRate, true);
    view.setUint32(28, audio.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, count * channels * 2, true);
    for (let n = 0; n < count; n++)
      for (let c = 0; c < channels; c++)
        view.setInt16(
          44 + (n * channels + c) * 2,
          Math.max(-1, Math.min(1, audio.getChannelData(c)[n]!)) * 32767,
          true,
        );
    return new File([out], "voiceover.wav", { type: "audio/wav" });
  } finally {
    await context.close();
  }
}
export function VoiceRecorder({
  onAccepted,
}: {
  onAccepted: (asset: AssetRef) => void;
}) {
  const [state, setState] = useState<
      "idle" | "requesting" | "recording" | "review" | "saving"
    >("idle"),
    [blob, setBlob] = useState<Blob>(),
    [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    generation = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function release() {
    clearTimeout(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }
  function cancel() {
    generation.current++;
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    setBlob(undefined);
    setState("idle");
    setError("");
  }
  useEffect(
    () => () => {
      generation.current++;
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!blob) {
      setUrl("");
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  async function start() {
    const run = ++generation.current;
    setState("requesting");
    setMessage("");
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw Error("Microphone recording is unavailable in this browser");
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (run !== generation.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      const chunks: BlobPart[] = [];
      const r = new MediaRecorder(media);
      recorder.current = r;
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      r.onstop = () => {
        if (run !== generation.current) return;
        release();
        setBlob(new Blob(chunks, { type: r.mimeType }));
        setState("review");
      };
      r.onerror = () => {
        if (run !== generation.current) return;
        cancel();
        setError("Recording failed; no asset was created");
      };
      r.start();
      setState("recording");
      timer.current = setTimeout(() => {
        if (r.state === "recording") r.stop();
      }, 120000);
    } catch (e) {
      if (run === generation.current) {
        release();
        setState("idle");
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }
  async function accept() {
    if (!blob) return;
    setState("saving");
    try {
      const file = await wav(blob),
        form = new FormData();
      form.set("file", file);
      form.set("kind", "audio");
      const response = await fetch("/api/studio/assets", {
          method: "POST",
          body: form,
        }),
        asset = await response.json();
      if (!response.ok) throw Error(asset.error);
      onAccepted(asset);
      setMessage("Recording saved to your media library.");
      setBlob(undefined);
      setState("idle");
    } catch (e) {
      setError(String(e));
      setState("review");
    }
  }
  return (
    <section
      className="space-y-3 rounded-xl border p-4"
      aria-label="Voice recording"
    >
      <h2 className="font-semibold">Voice recording</h2>
      <p className="text-xs text-muted-foreground">
        Grant microphone permission to record up to two minutes. Listen locally,
        then accept to create a new asset.
      </p>
      {state === "idle" && (
        <button className="rounded border p-2" onClick={() => void start()}>
          Record voiceover
        </button>
      )}
      {state === "requesting" && <p>Waiting for microphone permission…</p>}
      {state === "recording" && (
        <button
          className="rounded border p-2"
          onClick={() => recorder.current?.stop()}
        >
          Stop recording
        </button>
      )}
      {state === "review" && (
        <>
          <audio
            controls
            src={url || undefined}
            aria-label="Recorded voice preview"
          />
          <button className="rounded border p-2" onClick={() => void accept()}>
            Accept recording as new asset
          </button>
        </>
      )}
      {state !== "idle" && state !== "saving" && (
        <button className="ml-2 rounded border p-2" onClick={cancel}>
          Cancel recording
        </button>
      )}
      {state === "saving" && <p>Importing accepted recording…</p>}
      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
