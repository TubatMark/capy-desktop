import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEventServer, createEventService } from "./handler";
import { channelPattern } from "./subscriptions";

/** Optional independently hosted service. Launching/configuring it is an explicit deployment action. */
export async function runEventReceiver() {
  const storeFile = process.env.YOUTUBE_EVENT_STORE;
  const retrievalToken = process.env.YOUTUBE_EVENT_TOKEN;
  const callbackOrigin = process.env.YOUTUBE_CALLBACK_ORIGIN;
  const channels = [
    ...new Set(
      (process.env.YOUTUBE_EVENT_CHANNELS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (
    !storeFile ||
    !path.isAbsolute(storeFile) ||
    !retrievalToken ||
    !callbackOrigin ||
    !channels.length ||
    channels.length > 1000
  )
    throw Error(
      "Configure an absolute YOUTUBE_EVENT_STORE, independent YOUTUBE_EVENT_TOKEN, YOUTUBE_CALLBACK_ORIGIN and 1–1000 explicit YOUTUBE_EVENT_CHANNELS",
    );
  if (path.basename(storeFile) === "capy.sqlite")
    throw Error(
      "The receiver must use a separate database, never the desktop capy.sqlite",
    );
  if (channels.some((channel) => !channelPattern.test(channel)))
    throw Error("Invalid explicitly configured YouTube channel ID");
  const configured = new Set(channels);
  const port = Number(process.env.YOUTUBE_EVENT_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid receiver port");
  const service = createEventService({ storeFile, retrievalToken });
  for (const channel of channels)
    service.subscriptions.ensure(channel, callbackOrigin);
  const server = createEventServer(service);
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let renewal: Promise<void> | undefined;
  const maintain = async () => {
    renewal = service.subscriptions.renewDue(
      abort.signal,
      fetch,
      Date.now(),
      configured,
    );
    try {
      await renewal;
    } catch (error) {
      if (!abort.signal.aborted)
        console.error(
          "[youtube-events renewal]",
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      if (!abort.signal.aborted) {
        const delay = Math.min(
          60_000,
          Math.max(
            100,
            (service.subscriptions.nextRenewalAt(configured) ??
              Date.now() + 60_000) - Date.now(),
          ),
        );
        timer = setTimeout(() => {
          void maintain();
        }, delay);
      }
    }
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  void maintain();
  console.log(
    `YouTube event receiver listens on 127.0.0.1:${port}; ${channels.length} explicitly configured channels`,
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    abort.abort();
    clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await renewal?.catch(() => {});
    service.close();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void close();
    });
  return { close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runEventReceiver().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
