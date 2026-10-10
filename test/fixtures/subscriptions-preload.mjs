// Enabled only by Playwright's isolated server. No provider traffic leaves this harness.
import { readFileSync } from "node:fs";
import path from "node:path";
const originalFetch = globalThis.fetch;
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const channelId = (n) => `UC${String(n).padStart(22, "0")}`;
const marker = () => {
  try {
    return JSON.parse(
      readFileSync(
        path.join(
          process.env.CAPY_STUDIO_TEST_ROOT,
          "subscriptions-fixture.json",
        ),
        "utf8",
      ),
    );
  } catch {
    return {};
  }
};
if (process.env.CAPY_STUDIO_TEST_ROOT)
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "oauth2.googleapis.com") {
      return reply({
        access_token: "fixture-reading-reconnect",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/youtube.readonly",
      });
    }
    if (url.hostname === "www.googleapis.com") {
      if (marker().revoked)
        return reply(
          { error: { errors: [{ reason: "insufficientPermissions" }] } },
          403,
        );
      const resource = url.pathname.split("/").pop();
      if (resource === "subscriptions") {
        const offset = Number(url.searchParams.get("pageToken") ?? 0);
        const channels = Array.from(
          { length: Math.min(50, 120 - offset) },
          (_, i) => ({
            snippet: {
              title: `Creator ${offset + i}`,
              resourceId: { channelId: channelId(offset + i) },
            },
          }),
        );
        if (offset === 50)
          channels.push({
            snippet: {
              title: "Creator 1",
              resourceId: { channelId: channelId(1) },
            },
          });
        return reply({
          items: channels,
          nextPageToken: offset + 50 < 120 ? String(offset + 50) : undefined,
        });
      }
      if (resource === "channels" && url.searchParams.get("mine"))
        return reply({
          items: [{ id: "reader-b", snippet: { title: "Reader B" } }],
        });
      if (resource === "channels")
        return reply({
          items: [
            {
              contentDetails: {
                relatedPlaylists: {
                  uploads: `uploads-${url.searchParams.get("id")}`,
                },
              },
            },
          ],
        });
      if (resource === "playlistItems")
        return reply({
          items: [
            {
              snippet: {
                title: "Old upload",
                resourceId: { videoId: "old-fixture" },
              },
            },
          ],
        });
      if (resource === "videos")
        return reply({
          items: [{ id: "old-fixture", contentDetails: { duration: "PT10M" } }],
        });
      throw new Error(`Unexpected YouTube fixture request: ${url.pathname}`);
    }
    // Other provider calls fail visibly in the fixture harness.
    if (
      [
        "accounts.google.com",
        "graph.facebook.com",
        "open.tiktokapis.com",
      ].includes(url.hostname)
    )
      throw new Error("Provider traffic is disabled in Playwright fixtures");
    return originalFetch(input, init);
  };
