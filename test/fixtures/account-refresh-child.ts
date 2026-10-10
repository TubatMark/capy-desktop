import { getAccessToken } from "../../server/accounts";
const endpoint = process.env.CAPY_REFRESH_FIXTURE_ENDPOINT;
if (!endpoint || new URL(endpoint).hostname !== "127.0.0.1")
  throw Error("Loopback fixture required");
process.send?.({ ready: true });
process.once("message", async () => {
  try {
    const token = await getAccessToken(
      "youtube",
      (async (url, init) => {
        if (String(url) !== "https://oauth2.googleapis.com/token")
          throw Error("External network denied");
        return fetch(endpoint, init);
      }) as typeof fetch,
      "fixture-account",
    );
    process.send?.({ token });
    process.disconnect?.();
  } catch (error) {
    process.send?.({
      error: error instanceof Error ? error.message : String(error),
    });
    process.disconnect?.();
    process.exitCode = 1;
  }
});
