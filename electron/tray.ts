import type { AutomationHealth } from "../lib/creator-policy";
import { Menu, nativeImage, Notification, powerSaveBlocker, Tray } from "electron";
import { newReviewNotice, trayMenuModel, type TraySummary } from "./tray-model";

/** build/trayTemplate@2x.png (the capy silhouette), inlined so the packaged app needs no extra file. */
const ICON_2X =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAlklEQVR4nO2U4QqAIAyEN/H9X/kiSCjRMMntqH3/CvI+z6VIEHwMXbw+nmYlI5nWs6kQZj/MXsFvCkEWkgcC1UCkrK1qufuDXqau/sum8BZC3ZrHkfUuSdzdntazhPLOU2hHR2bISqaZ5T3UtRSSYzstlKGhSxEsQtIS8j4u/oaohCAkJCEjCQfKJiRnIYb5gbdAEPyHDQksGyU7i3HFAAAAAElFTkSuQmCC";

/**
 * The menu-bar icon: shows the next scheduled post and keeps capy posting while the window is closed.
 * State comes from the app's own server (/api/queue/summary).
 */
export function createTray(o: {
  serverUrl: () => string | undefined;
  show: (path?: string) => void;
  quit: () => void;
}) {
  const img = nativeImage.createFromBuffer(
    Buffer.from(ICON_2X.split(",")[1]!, "base64"),
    { scaleFactor: 2 },
  );
  img.setTemplateImage(true);
  const tray = new Tray(img);
  tray.setToolTip("capy");
  let summary: TraySummary & { paused?: boolean } = {
    review: 0,
    activeCount: 0,
  };
  let health: AutomationHealth | undefined;
  let seenReview: number | undefined;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function render() {
    const items = trayMenuModel(
      summary,
      !!summary.paused || !!health?.controls.postPaused,
      tz,
    );
    const controls = health?.controls;
    const extra = [
      {
        label: health?.online
          ? "Worker online"
          : "Worker offline · future work waits",
        enabled: false,
      },
      ...(
        [
          ["monitorPaused", "monitoring"],
          ["renderPaused", "rendering"],
          ["globalStop", "all future work"],
        ] as const
      ).map(([key, label]) => ({
        label: `${controls?.[key] ? "Resume" : "Stop"} ${label}`,
        enabled: !!health,
        click: () => void setControl(key),
      })),
    ];
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...extra,
        ...items.map((it) =>
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
                  else if (it.id === "pause")
                    void setPaused(
                      !summary.paused && !health?.controls.postPaused,
                    );
                },
              },
        ),
      ]),
    );
  }

  async function setControl(key: keyof AutomationHealth["controls"]) {
    const url = o.serverUrl();
    if (!url || !health) return;
    await fetch(`${url}/api/automation/health`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        controls: { ...health.controls, [key]: !health.controls[key] },
      }),
    }).catch(() => {});
    await refresh();
  }

  async function setPaused(paused: boolean) {
    const url = o.serverUrl();
    if (!url) return;
    await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postingPaused: paused }),
    }).catch(() => {});
    if (health)
      await fetch(`${url}/api/automation/health`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          controls: { ...health.controls, postPaused: paused },
        }),
      }).catch(() => {});
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
    try {
      const r = await fetch(`${url}/api/automation/health`);
      if (r.ok) health = await r.json();
      else health = undefined;
    } catch {
      health = undefined;
    }
    // watching channels counts as work too, so new uploads are caught while the Mac sits locked
    const c = health?.controls;
    keepAwake(
      summary.activeCount > 0 ||
        (!!health && !c?.globalStop && !c?.monitorPaused && (summary.watching ?? 0) > 0),
    );
    render();
  }

  // Posts upload at their slot time and new uploads are found by hourly checks, so an idle-sleeping Mac would
  // miss both. While capy has work, hold off idle sleep: the screen may still turn off and lock, but a closed
  // lid on battery still sleeps.
  let blocker: number | undefined;
  function keepAwake(on: boolean) {
    if (on && blocker === undefined)
      blocker = powerSaveBlocker.start("prevent-app-suspension");
    else if (!on && blocker !== undefined) {
      powerSaveBlocker.stop(blocker);
      blocker = undefined;
    }
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
      keepAwake(false);
      tray.destroy();
    },
  };
}
