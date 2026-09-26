import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { hasCommand, run } from "./exec";
import { parseWhisperJson } from "./captions";
import type { Word } from "./types";

export interface TranscribeOpts {
  /** whisper.cpp model path (ggml-*.bin). Defaults to $WHISPER_MODEL. */
  model?: string;
  language?: string;
}

/**
 * Fallback transcription when YouTube has no captions.
 * Tries mlx-whisper (Apple silicon GPU), then whisper-cli (whisper.cpp).
 */
export async function transcribe(audio: string, dir: string, o: TranscribeOpts = {}): Promise<Word[]> {
  await mkdir(dir, { recursive: true });
  // Whisper uses ISO 639-1 codes; YouTube says "fil" for Filipino. Undefined = auto-detect.
  const lang = o.language ? ({ fil: "tl" } as Record<string, string>)[o.language] ?? o.language.split("-")[0] : undefined;

  if (await hasCommand("mlx_whisper")) {
    const outBase = path.join(dir, "whisper");
    await rm(outBase + ".json", { force: true }); // never read back a stale transcript
    await run("mlx_whisper", [
      audio,
      "--model",
      process.env.MLX_WHISPER_MODEL ?? "mlx-community/whisper-large-v3-turbo",
      ...(lang ? ["--language", lang] : []),
      "--word-timestamps",
      "True",
      "--output-format",
      "json",
      "--output-dir",
      dir,
      "--output-name",
      "whisper",
    ]);
    // mlx_whisper prints errors and still exits 0, so check the file exists
    const out = await readFile(outBase + ".json", "utf8").catch(() => {
      throw new Error("mlx_whisper did not produce a transcript. Run it by hand on work/audio.m4a to see the error.");
    });
    return parseWhisperJson(out);
  }

  const cli = (await hasCommand("whisper-cli")) ? "whisper-cli" : (await hasCommand("whisper-cpp")) ? "whisper-cpp" : null;
  if (cli) {
    const model = o.model ?? process.env.WHISPER_MODEL;
    if (!model) throw new Error("Set WHISPER_MODEL to a ggml model file (e.g. ~/models/ggml-large-v3-turbo.bin) for whisper.cpp");
    const wav = path.join(dir, "audio16k.wav");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", audio, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const outBase = path.join(dir, "whisper");
    await run(cli, ["-m", model, "-f", wav, "-l", lang ?? "auto", "-oj", "-of", outBase, "-ml", "1", "-sow"]);
    return parseWhisperJson(await readFile(outBase + ".json", "utf8"));
  }

  throw new Error(
    "No captions on this video and no local transcriber found.\n" +
      "Install one:  pip install mlx-whisper   (fastest on Apple silicon)\n" +
      "         or:  brew install whisper-cpp  and set WHISPER_MODEL=/path/to/ggml-large-v3-turbo.bin",
  );
}
