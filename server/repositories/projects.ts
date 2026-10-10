import type { ProjectDocument, AssetRef } from "../../lib/studio/types";
import type { Store } from "../db";
export function projectRepository(store: Store) {
  return {
    get: (id: string) => {
      const row = store.get<ProjectDocument>("projects", id);
      return row ? { ...row.value, revision: row.revision } : undefined;
    },
    saveProject: async (
      doc: ProjectDocument,
      expectedRevision: number,
    ): Promise<ProjectDocument> => {
      const row = store.save("projects", doc.id, doc, expectedRevision);
      return { ...doc, revision: row.revision };
    },
    saveAsset: (asset: AssetRef, expectedRevision: number) =>
      store.save("assets", asset.id, asset, expectedRevision),
    getAsset: (id: string) => store.get<AssetRef>("assets", id),
  };
}
