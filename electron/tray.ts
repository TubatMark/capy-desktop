import { Menu, nativeImage, Notification, Tray } from "electron";
import { newReviewNotice, trayMenuModel, type TraySummary } from "./tray-model";

/** build/trayTemplate@2x.png (the capy silhouette), inlined so the packaged app needs no extra file. */
const ICON_2X = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAlklEQVR4nO2U4QqAIAyEN/H9X/kiSCjRMMntqH3/CvI+z6VIEHwMXbw+nmYlI5nWs6kQZj/MXsFvCkEWkgcC1UCkrK1qufuDXqau/sum8BZC3ZrHkfUuSdzdntazhPLOU2hHR2bISqaZ5T3UtRSSYzstlKGhSxEsQtIS8j4u/oaohCAkJCEjCQfKJiRnIYb5gbdAEPyHDQksGyU7i3HFAAAAAElFTkSuQmCC";

/**
 * The menu-bar icon: shows the next scheduled post and keeps capy posting while the window is closed.
 * State comes from the app's own server (/api/queue/summary).
 */
export function createTray(o: { serverUrl: () => string | undefined; show: (path?: string) => void; quit: () => void }) {
  const img = nativeImage.createFromBuffer(Buffer.from(ICON_2X.split(",")[1]!, "base64"), { scaleFactor: 2 });
  img.setTemplateImage(true);
  const tray = new Tray(img);
  tray.setToolTip("capy");
  let summary: TraySummary & { paused?: boolean } = { review: 0, activeCount: 0 };
  let seenReview: number | undefined;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function render() {
    const items = trayMenuModel(summary, !!summary.paused, tz);
    tray.setContextMenu(
      Menu.buildFromTemplate(
        items.map((it) =>
          it.separator
            ? { type: "separator" as const }
            : {
                label: it.label,
                enabled: it.enabled ?? true,
                click: () => {
                  if (it.id === "open") o.show();
                  else if (it.id === "queue") o.show("/queue");
                  else if (it.id === "automation") o.show("/automation");
                  else if (it.id === "quit") o.quit();
                  else if (it.id === "pause") void setPaused(!summary.paused);
                },
              },
        ),
      ),
    );
  }

  async function setPaused(paused: boolean) {
    const url = o.serverUrl();
    if (!url) return;
    await fetch(`${url}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postingPaused: paused }) }).catch(() => {});
    await refresh();
  }

  async function refresh() {
    const url = o.serverUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/api/queue/summary`);
      if (r.ok) {
        const prev = seenReview;
        summary = await r.json();
        seenReview = summary.review;
        // automation finished clips while the user was elsewhere: say so (clicking opens the review list)
        const text = newReviewNotice(prev, summary.review);
        if (text && Notification.isSupported()) {
          const n = new Notification({ title: "capy", body: text });
          n.on("click", () => o.show("/queue"));
          n.show();
        }
      }
    } catch {
      /* server restarting */
    }
    render();
  }

  render();
  void refresh();
  const timer = setInterval(() => void refresh(), 60_000);
  return {
    refresh,
    /** Posts are scheduled or uploading: closing the window should keep capy running. */
    hasActive: () => summary.activeCount > 0,
    destroy() {
      clearInterval(timer);
      tray.destroy();
    },
  };
}
