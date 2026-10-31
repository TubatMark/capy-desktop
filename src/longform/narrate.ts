import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "../exec";
import { DEFAULT_VOICE, narrate as say } from "../story/narrate";

/**
 * The narrator: Piper when it's installed (`node scripts/setup-voice.mjs`), running as its own program, else the voice
 * built into macOS. The Piper voice is CC0, so it stays usable if the channel earns money.
 */
export const PIPER_VOICE = "en_US-joe-medium";

export const piperPaths = (dataDir: string) => {
  const root = path.join(dataDir, "tools", "piper");
  return { bin: path.join(root, "venv", "bin", "piper"), model: path.join(root, `${PIPER_VOICE}.onnx`) };
};

const seconds = async (file: string) => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("The narration came out empty");
  return d;
};

/** Speak `text` into `out` (no extension); returns the file, its length, and which voice read it. */
export async function speak(text: string, out: string, dataDir: string): Promise<{ file: string; seconds: number; voice: string }> {
  const { bin, model } = piperPaths(dataDir);
  if (existsSync(bin) && existsSync(model)) {
    const file = `${out}.wav`;
    const input = `${out}.txt`;
    await writeFile(input, text, "utf8");
    await run(bin, ["-m", model, "-i", input, "-f", file, "--sentence-silence", "0.25"]);
    return { file, seconds: await seconds(file), voice: `Piper ${PIPER_VOICE}` };
  }
  const file = `${out}.aiff`;
  return { file, seconds: await say(text, DEFAULT_VOICE, file), voice: `macOS ${DEFAULT_VOICE}` };
}
