import { mapSources } from "../../lib/studio/operations";
import type { ProjectDocument } from "../../lib/studio/types";
export const project = (): ProjectDocument =>
  mapSources({
    schemaVersion: 1,
    id: "advanced",
    revision: 4,
    canvas: { width: 320, height: 240 },
    fps: { numerator: 30, denominator: 1 },
    tracks: [{ id: "v", kind: "video", role: "main" }],
    items: [
      {
        id: "a",
        trackId: "v",
        assetId: "asset",
        startFrame: 0,
        durationFrames: 120,
        sourceInUs: 0,
        sourceOutUs: 4000000,
        speed: 1,
      },
    ],
    sourceMappings: [],
    captionCues: [],
    sourceWords: [
      {
        assetId: "asset",
        words: [
          { id: "word", text: "Hello", startUs: 1000000, endUs: 2000000 },
        ],
      },
    ],
    thumbnailIds: [],
  });
