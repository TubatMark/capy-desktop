import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const saving = new Map<string, Promise<void>>();

/**
 * Write JSON so a reader (or a crash) never sees half a file: a temp file renamed over the old one. Saves of one
 * file run in call order, so the last call's data is what stays.
 */
export function saveJsonAtomic(file: string, data: unknown): Promise<void> {
  const body = JSON.stringify(data, null, 2);
  const next = (saving.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, file);
    });
  saving.set(file, next);
  void next.finally(() => saving.get(file) === next && saving.delete(file)).catch(() => {});
  return next;
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
