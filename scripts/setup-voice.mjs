#!/usr/bin/env node
// Installs the long-form narrator on this computer: Piper, pinned, in its own Python environment, plus a CC0 voice.
// It runs as a separate program and isn't bundled with the app. Safe to run again.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PIPER = "1.8.0";
const VOICE = "en_US-joe-medium";
const BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium";
const data = process.env.CAPY_DATA_DIR ?? path.join(homedir(), "Library", "Application Support", "capy");
const root = path.join(data, "tools", "piper");
mkdirSync(root, { recursive: true });

const python = ["/opt/homebrew/bin/python3", "python3"].find((p) => {
  try {
    const v = execFileSync(p, ["-c", "import sys;print(sys.version_info >= (3, 10))"], { encoding: "utf8" });
    return v.trim() === "True";
  } catch {
    return false;
  }
});
if (!python) throw new Error("Piper needs Python 3.10 or newer: brew install python");

const venv = path.join(root, "venv");
if (!existsSync(path.join(venv, "bin", "python"))) execFileSync(python, ["-m", "venv", venv], { stdio: "inherit" });
execFileSync(path.join(venv, "bin", "pip"), ["install", "--quiet", "--only-binary", ":all:", `piper-tts==${PIPER}`], { stdio: "inherit" });

for (const name of [`${VOICE}.onnx`, `${VOICE}.onnx.json`]) {
  const file = path.join(root, name);
  if (existsSync(file)) continue;
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`Could not download ${name}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
console.log(`Narrator ready: Piper ${PIPER}, voice ${VOICE}, in ${root}`);
