import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Store } from "./db";
/** Independent consent epoch: metric refresh attempts do not invalidate this cache. */
export function channelCacheGeneration(store: Store, accountId: string) {
  return (
    store.get<{ generation: number }>("channel-cache-epochs", accountId)?.value
      .generation ?? 0
  );
}
export function purgeChannelCache(store: Store, accountId: string) {
  store.mutate(
    "channel-cache-epochs",
    accountId,
    () => ({ generation: 0 }),
    (x) => ({ generation: x.generation + 1 }),
  );
  const file = path.join(path.dirname(store.file), "channel.json");
  if (!existsSync(file)) return;
  let snapshot: {
    channel?: { id?: string };
    cacheBinding?: { accountId?: string };
  } | null;
  try {
    snapshot = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    unlinkSync(file);
    return;
  }
  if (
    !snapshot ||
    snapshot.cacheBinding?.accountId === accountId ||
    (!snapshot.cacheBinding && snapshot.channel?.id === accountId)
  )
    unlinkSync(file);
}
