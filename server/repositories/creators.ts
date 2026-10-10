import type { Store } from "../db";
export const creatorRepository = (store: Store) => ({
  save: <T>(id: string, value: T, revision: number) =>
    store.save("creators", id, value, revision),
  get: (id: string) => store.get("creators", id),
  claimSource: (provider: string, videoId: string, id: string) =>
    store.claim("source-video", JSON.stringify([provider, videoId]), id),
});
