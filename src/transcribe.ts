import { readFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { hasCommand, run } from "./exec";
import { parseWhisperJson } from "./captions";
import type { Word } from "./types";

export interface TranscribeOpts {
  /** whisper.cpp model path (ggml-*.bin). Defaults to $WHISPER_MODEL, then the first model found in WHISPER_MODEL_DIRS. */
  model?: string;
  language?: string;
}

/** Where whisper.cpp models are looked for when no path is given (in order). */
export const WHISPER_MODEL_DIRS = [path.join(homedir(), "models"), path.join(homedir(), ".cache", "whisper.cpp"), path.join(homedir(), ".cache", "whisper")];

/** Best first. English-only ("…-turbo.en") and quantised ("…-q5_0") variants sort right after their base model. */
const PREFERENCE = ["large-v3-turbo", "large-v3", "large-v2", "large-v1", "large", "medium", "small", "base", "tiny"];

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";
export const WHISPER_MODEL_FIX = `curl -L --create-dirs -o ~/models/ggml-large-v3-turbo.bin ${MODEL_URL}`;
export const WHISPER_NO_MODEL =
  "whisper-cli is installed but has no model file, so videos without YouTube captions can't be transcribed.\n" +
  `Download one (≈1.6 GB) with:\n${WHISPER_MODEL_FIX}\n` +
  "capy looks in ~/models; or set WHISPER_MODEL to a ggml-*.bin you already have. Then try this video again.";

/** Order ggml model files best-first; anything that isn't a ggml-*.bin is dropped. */
export function rankGgmlModels(files: string[]): string[] {
  const rank = (f: string) => {
    const name = path.basename(f).toLowerCase();
    if (!name.startsWith("ggml-") || !name.endsWith(".bin")) return Infinity;
    const stem = name.slice(5, -4);
    const i = PREFERENCE.findIndex((p) => stem === p || stem.startsWith(p + "-") || stem.startsWith(p + "."));
    if (i < 0) return PREFERENCE.length * 4;
    // exact base < quantised < english-only < both
    return i * 4 + (stem.includes(".en") ? 2 : 0) + (/-q\d/.test(stem) ? 1 : 0);
  };
  return files.filter((f) => rank(f) !== Infinity).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

async function isFile(p: string) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** The whisper.cpp model to use: `explicit`, then $WHISPER_MODEL, then the best ggml-*.bin in WHISPER_MODEL_DIRS. */
export async function findWhisperModel(explicit?: string): Promise<string | undefined> {
  for (const p of [explicit, process.env.WHISPER_MODEL]) {
    if (p && (await isFile(p.replace(/^~(?=$|\/)/, homedir())))) return p.replace(/^~(?=$|\/)/, homedir());
  }
  const found: string[] = [];
  for (const dir of WHISPER_MODEL_DIRS) {
    // user folders outside the app: don't let the file tracer follow this into the project
    const names = await readdir(/*turbopackIgnore: true*/ dir).catch(() => [] as string[]);
    for (const n of names) found.push(path.join(dir, n));
  }
  return rankGgmlModels(found)[0];
}

export type TranscriberStatus =
  | { backend: "mlx_whisper" }
  | { backend: "whisper-cli" | "whisper-cpp"; model: string }
  | { backend: "whisper-cli" | "whisper-cpp"; model?: undefined; problem: string; fix: string }
  | { backend: null };

/** What local transcription would use right now. Shared by the pipeline error and the setup check. */
export async function transcriberStatus(): Promise<TranscriberStatus> {
  if (await hasCommand("mlx_whisper")) return { backend: "mlx_whisper" };
  const cli = (await hasCommand("whisper-cli")) ? "whisper-cli" : (await hasCommand("whisper-cpp")) ? "whisper-cpp" : null;
  if (!cli) return { backend: null };
  const model = await findWhisperModel();
  return model ? { backend: cli, model } : { backend: cli, problem: WHISPER_NO_MODEL, fix: WHISPER_MODEL_FIX };
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
    const model = await findWhisperModel(o.model);
    if (!model) throw new Error(WHISPER_NO_MODEL);
    const wav = path.join(dir, "audio16k.wav");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", audio, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const outBase = path.join(dir, "whisper");
    await run(cli, ["-m", model, "-f", wav, "-l", lang ?? "auto", "-oj", "-of", outBase, "-ml", "1", "-sow"]);
    return parseWhisperJson(await readFile(outBase + ".json", "utf8"));
  }

  throw new Error(
    "This video has no YouTube captions and no local transcriber is installed.\n" +
      "Install one:  pip install mlx-whisper   (fastest on Apple silicon)\n" +
      `         or:  brew install whisper-cpp  and download a model:\n${WHISPER_MODEL_FIX}\n` +
      "Then try this video again.",
  );
}
