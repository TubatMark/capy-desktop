import { autopilotActions, describeAction, recommendSlot, type AutopilotAction } from "../../lib/longform";
import { freeSpace } from "./cleanup";
import { availableClips, createVideo, footageByCreator, getVideo, listVideos, loadAutopilot, loadSlots, logAutopilot, patchVideo } from "./store";
import { viewsLookup, ytDeps, type Step } from "./worker";
import { setPublishTime } from "./youtube";

/** The same steps the buttons on the board take, so automatic and manual runs can't drift apart. */
export function startUpload(id: string, now = Date.now()) {
  patchVideo(id, { status: "uploading", step: "Starting the upload", progress: 0, error: undefined, failedStep: undefined, uploadStartedAt: now });
}

async function act(a: AutopilotAction, queue: (s: Step) => Promise<unknown>, now: number) {
  switch (a.kind) {
    case "retry": {
      const v = getVideo(a.id)!;
      await queue({ id: a.id, step: v.failedStep!, index: v.failedIndex });
      patchVideo(a.id, { error: undefined, failedStep: undefined, failedIndex: undefined, step: "Trying again", autoRetries: (v.autoRetries ?? 0) + 1 });
      return;
    }
    case "draft": {
      const video = createVideo(a.creator, await viewsLookup());
      await queue({ id: video.id, step: "plan" });
      return;
    }
    case "upload":
      startUpload(a.id, now);
      await queue({ id: a.id, step: "upload" });
      return;
    case "publish": {
      const videos = listVideos();
      const slot = recommendSlot(loadSlots(), videos.filter((v) => v.slotAt).map((v) => ({ at: v.slotAt!, slotId: v.slotId })), now);
      const v = getVideo(a.id)!;
      if (!slot || !v.youtube?.id) return;
      await setPublishTime(await ytDeps(), v.youtube.id, slot.at);
      patchVideo(a.id, { status: "scheduled", slotAt: slot.at, slotId: slot.slot.id });
      return;
    }
    case "free":
      freeSpace(a.id, now);
      return;
  }
}

/** Runs on the worker's regular check. One failing action doesn't stop the others. */
export async function autopilotTick(queue: (s: Step) => Promise<unknown>, now = Date.now()) {
  const settings = loadAutopilot();
  if (!settings.draft && !settings.upload && !settings.publish && !settings.free && !listVideos().some((v) => v.error)) return;
  const footage = settings.draft ? footageByCreator(availableClips(await viewsLookup())) : [];
  for (const a of autopilotActions(listVideos(), footage, settings, now)) {
    const title = "id" in a ? getVideo(a.id)?.title : undefined;
    try {
      await act(a, queue, now);
      logAutopilot(describeAction(a, title), now);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      logAutopilot(`Couldn't finish: ${describeAction(a, title)}. ${why}`, now);
      console.error("[long-form autopilot]", e);
    }
  }
}
