import type { Store } from "../db";
/** Delivery identities bind an immutable package to a specific destination. */
export const publicationRepository = (store: Store) => ({
  reserveDelivery: (packageId: string, destinationId: string, id: string) =>
    store.claim("delivery", JSON.stringify([packageId, destinationId]), id),
  save: <T>(id: string, value: T, revision: number) =>
    store.save("publications", id, value, revision),
  get: (id: string) => store.get("publications", id),
});
