import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { buildMenu } from "./menu";
import { ServerError, startServer, type RunningServer } from "./server";
import { loadWindowState, trackWindowState } from "./window-state";

/** Matches --background in app/globals.css (light theme), so the window does not flash white. */
const BACKGROUND = "#fef9f1";

app.setName("capy");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | undefined;
  let server: RunningServer | undefined;
  let quitting = false;

  const userData = app.getPath("userData");

  function showFatal(title: string, message: string, tail: string[]) {
    const detail = tail.length ? `\n\nLast server output:\n${tail.join("\n")}` : "";
    dialog.showErrorBox(title, `${message}${detail}`);
  }

  function createWindow(): BrowserWindow {
    const state = loadWindowState(userData);
    const w = new BrowserWindow({
      ...state,
      minWidth: 400,
      minHeight: 600,
      show: false,
      title: "capy",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
      backgroundColor: BACKGROUND,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    if (state.x === undefined) w.center();
    trackWindowState(userData, w);

    const isOurs = (url: string) => !!server && url.startsWith(server.url);
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (isOurs(url)) return { action: "allow" };
      void shell.openExternal(url);
      return { action: "deny" };
    });
    w.webContents.on("will-navigate", (event, url) => {
      if (isOurs(url)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });
    w.once("ready-to-show", () => w.show());
    w.on("closed", () => {
      if (win === w) win = undefined;
    });
    win = w;
    return w;
  }

  function showWindow() {
    const fresh = !win;
    const w = win ?? createWindow();
    if (fresh && server) void w.loadURL(server.url);
    if (w.isMinimized()) w.restore();
    w.focus();
  }

  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(buildMenu({ dataDir: userData, serverUrl: () => server?.url, getWindow: () => win ?? createWindow() }));

    // Open the window first so the app feels alive while the server boots; the page loads once it is ready.
    const w = createWindow();

    try {
      server = await startServer({
        dev: !app.isPackaged,
        dataDir: userData,
        onExit: (code, signal, tail) => {
          if (quitting) return;
          showFatal("capy stopped", `The capy server exited unexpectedly (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""}).`, tail);
          app.quit();
        },
      });
    } catch (err) {
      const tail = err instanceof ServerError ? err.stderrTail : [];
      showFatal("capy could not start", err instanceof Error ? err.message : String(err), tail);
      quitting = true;
      app.quit();
      return;
    }

    if (!w.isDestroyed()) await w.loadURL(server.url);
    else showWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting || !server) {
      quitting = true;
      return;
    }
    quitting = true;
    event.preventDefault();
    void server.stop().finally(() => app.quit());
  });
}
