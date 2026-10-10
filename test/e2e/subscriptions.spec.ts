import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const root = process.env.CAPY_STUDIO_TEST_ROOT!;
const data = path.join(root, "data");
const marker = path.join(root, "subscriptions-fixture.json");
const id = (n: number) => `UC${String(n).padStart(22, "0")}`;
test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  mkdirSync(data, { recursive: true });
  writeFileSync(
    path.join(data, "accounts.json"),
    JSON.stringify({
      youtube: {
        clientId: "fixture-id",
        clientSecret: "fixture-secret",
        account: { id: "publisher", name: "Publisher" },
        tokens: {
          accessToken: "fixture-publishing",
          expiresAt: Date.now() + 3600_000,
        },
        autoPost: false,
      },
      instagram: {},
      tiktok: {},
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(data, "youtube-reading.json"),
    JSON.stringify({
      clientId: "fixture-id",
      clientSecret: "fixture-secret",
      account: { id: "reader-a", name: "Reader A" },
      tokens: {
        accessToken: "fixture-reading",
        expiresAt: Date.now() + 3600_000,
        scope: "https://www.googleapis.com/auth/youtube.readonly",
      },
    }),
    { mode: 0o600 },
  );
  writeFileSync(marker, "{}");
});
test("imports selected unique creators across pages through the real API without backfill or publication", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const before = readFileSync(path.join(data, "accounts.json"), "utf8");
  await page.goto("/automation");
  const picker = page.getByRole("region", {
    name: "Import YouTube subscriptions",
  });
  await expect(picker).toContainText("Reading account: Reader A");
  await picker.getByRole("button", { name: "Refresh subscriptions" }).click();
  await expect(picker).toContainText("50 loaded");
  await picker.getByRole("button", { name: "Load more subscriptions" }).click();
  await expect(picker).toContainText("100 loaded");
  await picker.getByRole("button", { name: "Load more subscriptions" }).click();
  await expect(picker).toContainText("120 loaded");
  await expect(
    picker.getByRole("button", { name: "Load more subscriptions" }),
  ).toHaveCount(0);
  await picker.getByLabel("Search subscriptions").fill("Creator 11");
  await expect(
    picker.getByRole("checkbox", { name: "Select Creator 110", exact: true }),
  ).toBeVisible();
  await picker
    .getByRole("checkbox", { name: "Select Creator 110", exact: true })
    .check();
  await picker.getByLabel("Search subscriptions").fill("");
  await picker
    .getByRole("checkbox", { name: "Select Creator 1", exact: true })
    .check();
  await expect(picker.getByLabel("Initial creator mode")).toHaveValue("manual");
  await expect(
    picker.getByRole("checkbox", { name: /backfill/ }),
  ).not.toBeChecked();
  await picker
    .getByRole("button", { name: "Import 2 selected creators" })
    .click();
  await expect(picker.getByRole("status")).toContainText("Imported 2 creators");
  const state = await (await request.get("/api/automation")).json();
  expect(state.channels.map((c: { id: string }) => c.id).sort()).toEqual(
    [id(1), id(110)].sort(),
  );
  for (const c of state.channels)
    expect(c).toMatchObject({
      mode: "manual",
      enabled: false,
      seen: ["old-fixture"],
      pending: [],
      sourceAccountId: "reader-a",
    });
  expect(readFileSync(path.join(data, "accounts.json"), "utf8")).toBe(before);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("subscriptions-import.png"),
    fullPage: true,
  });
});
test("revoked reading access offers reconnect and changing the reading principal preserves the publishing account", async ({
  page,
  request,
}, info) => {
  const before = readFileSync(path.join(data, "accounts.json"), "utf8");
  writeFileSync(marker, JSON.stringify({ revoked: true }));
  await page.goto("/automation");
  const picker = page.getByRole("region", {
    name: "Import YouTube subscriptions",
  });
  await picker.getByRole("button", { name: "Refresh subscriptions" }).click();
  await expect(picker.getByRole("alert")).toContainText("Reconnect");
  await picker.getByRole("link", { name: "Reconnect reading account" }).click();
  const reading = page.getByRole("region", {
    name: "Subscription reading account",
  });
  await expect(reading).toContainText("Reader A");
  await expect(
    page.getByRole("heading", { name: "YouTube publishing destination" }),
  ).toBeVisible();
  await expect(page.getByText("Publisher", { exact: true })).toBeVisible();
  writeFileSync(marker, "{}");
  // Start consent through the actual endpoint, then finish the UI paste-back flow with fixture Google replies.
  const started = await (
    await request.post("/api/accounts/youtube/connect?role=reading")
  ).json();
  const state = new URL(started.url).searchParams.get("state");
  expect(new URL(started.url).searchParams.get("scope")).toBe(
    "https://www.googleapis.com/auth/youtube.readonly",
  );
  await reading.getByRole("button", { name: /Paste the address/ }).click();
  await reading
    .getByPlaceholder("http://localhost:53682/callback?code=…")
    .fill(`http://127.0.0.1:53682/callback?code=fixture&state=${state}`);
  await reading.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(reading).toContainText("Reader B");
  expect(readFileSync(path.join(data, "accounts.json"), "utf8")).toBe(before);
  await page.goto("/automation");
  await expect(picker).toContainText("Reading account: Reader B");
  const creators = (await (await request.get("/api/automation")).json())
    .channels;
  expect(creators).toHaveLength(2);
  expect(
    creators.every(
      (c: { sourceAccountId: string }) => c.sourceAccountId === "reader-a",
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("subscriptions-reconnected.png"),
    fullPage: true,
  });
});
