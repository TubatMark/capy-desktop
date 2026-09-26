import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Mirrors server/paths.ts: settings.outputDir → CAPY_OUTPUT → ~/Movies/capy (desktop default). */
export function outputDir(dataDir: string): string {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")) as { outputDir?: unknown };
    if (typeof settings.outputDir === "string" && settings.outputDir.trim()) return path.resolve(settings.outputDir.replace(/^~(?=$|\/)/, os.homedir()));
  } catch {
    // no settings file yet
  }
  if (process.env.CAPY_OUTPUT) return path.resolve(process.env.CAPY_OUTPUT);
  return path.join(os.homedir(), "Movies", "capy");
}

export interface MenuOptions {
  dataDir: string;
  /** The running server's origin, e.g. http://127.0.0.1:53211 */
  serverUrl: () => string | undefined;
  /** The current (or a freshly created) main window. */
  getWindow: () => BrowserWindow | undefined;
}

export function buildMenu(opts: MenuOptions): Menu {
  const openSettings = () => {
    const url = opts.serverUrl();
    const win = opts.getWindow();
    if (url && win) void win.loadURL(`${url}/settings`);
  };
  const openOutputFolder = async () => {
    const dir = outputDir(opts.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) console.warn("[menu] openPath:", err);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open Output Folder", accelerator: "CmdOrCtrl+Shift+O", click: () => void openOutputFolder() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }, { type: "separator" }, { role: "window" }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
