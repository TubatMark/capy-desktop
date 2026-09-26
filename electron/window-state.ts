import { screen, type BrowserWindow, type Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const DEFAULT: WindowState = { width: 1280, height: 800 };
const FILE = "window.json";

function statePath(userData: string) {
  return path.join(userData, FILE);
}

function isRect(v: unknown): v is Required<WindowState> {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** The saved rect if it is at least partly on a currently attached display, else a centered 1280×800 default. */
export function loadWindowState(userData: string): WindowState {
  let saved: unknown;
  try {
    saved = JSON.parse(fs.readFileSync(statePath(userData), "utf8"));
  } catch {
    return { ...DEFAULT };
  }
  if (!isRect(saved) || saved.width < 400 || saved.height < 600) return { ...DEFAULT };
  const onScreen = screen.getAllDisplays().some((d) => intersects(d.workArea, saved));
  return onScreen ? { ...saved } : { ...DEFAULT };
}

export function saveWindowState(userData: string, win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  const b = win.getNormalBounds();
  const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height };
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(statePath(userData), JSON.stringify(state));
  } catch (err) {
    console.warn("[window-state] could not save:", err);
  }
}

/** Save on move/resize (debounced) and on close. */
export function trackWindowState(userData: string, win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveWindowState(userData, win), 300);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    saveWindowState(userData, win);
  });
}
