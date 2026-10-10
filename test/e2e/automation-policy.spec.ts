import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const root = process.env.CAPY_STUDIO_TEST_ROOT!;
const channel = "UC0000000000000000000101";
test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  const data = path.join(root, "data");
  mkdirSync(data, { recursive: true });
  // No real credentials/provider requests. Global stop keeps these UI fixtures idle.
  writeFileSync(
    path.join(data, "settings.json"),
    JSON.stringify({
      automationControls: {
        monitorPaused: false,
        renderPaused: false,
        postPaused: false,
        globalStop: true,
      },
    }),
  );
  writeFileSync(
    path.join(data, "youtube-reading.json"),
    JSON.stringify({
      account: { id: "reader", name: "Reader" },
      tokens: {
        accessToken: "fixture",
        expiresAt: Date.now() + 3600000,
        scope: "https://www.googleapis.com/auth/youtube.readonly",
      },
    }),
  );
  writeFileSync(
    path.join(data, "accounts.json"),
    JSON.stringify({
      youtube: {
        account: { id: "publisher", name: "Publisher" },
        tokens: { accessToken: "fixture", expiresAt: Date.now() + 3600000 },
        autoPost: false,
      },
      instagram: {},
      tiktok: {},
    }),
  );
});
test("saves immutable draft recipe, separate worker controls, bounded policy and locked publication through real APIs", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const imported = await request.post("/api/subscriptions", {
    data: {
      accountId: "reader",
      selectedIds: [channel],
      backfill: false,
      mode: "automatic_drafts",
    },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await page.goto("/automation");
  const dashboard = page.getByRole("region", { name: "Automation operations" });
  await expect(dashboard).toContainText("Automatic publication is disabled");
  await dashboard
    .getByRole("button", { name: "Stop rendering", exact: true })
    .click();
  await expect(
    dashboard.getByRole("button", { name: "Resume rendering", exact: true }),
  ).toBeVisible();
  let health = await (await request.get("/api/automation/health")).json();
  expect(health.controls).toMatchObject({
    globalStop: true,
    renderPaused: true,
    monitorPaused: false,
    postPaused: false,
  });
  await dashboard
    .getByText("Creator recipe and capacity", { exact: true })
    .click();
  await dashboard
    .getByLabel("Automation mode")
    .selectOption("automatic_drafts");
  await dashboard.getByLabel("Edit template").selectOption("clean-portrait-v1");
  await dashboard.getByLabel("Recipe clips per source").fill("2");
  await dashboard.getByLabel("Daily automated clip limit").fill("4");
  await dashboard
    .getByRole("button", { name: "Save creator recipe", exact: true })
    .click();
  await expect(dashboard).toContainText("Saved recipe version:");
  health = await (await request.get("/api/automation/health")).json();
  const first = health.policies[channel].recipeId;
  expect(health.policies[channel]).toMatchObject({
    mode: "automatic_drafts",
    clips: 2,
    dailyClipCap: 4,
    editTemplate: "clean-portrait-v1",
  });
  await dashboard
    .getByText("Creator recipe and capacity", { exact: true })
    .click();
  await dashboard.getByLabel("Edit template").selectOption("bold-portrait-v1");
  await dashboard
    .getByRole("button", { name: "Save creator recipe", exact: true })
    .click();
  await expect
    .poll(async () => {
      const h = await (await request.get("/api/automation/health")).json();
      return h.policies[channel].recipeId;
    })
    .not.toBe(first);
  health = await (await request.get("/api/automation/health")).json();
  const blocked = await request.put("/api/automation/health", {
    data: {
      channelId: channel,
      policy: { ...health.policies[channel], mode: "automatic_publish" },
    },
  });
  expect(blocked.status()).toBe(400);
  expect((await blocked.json()).error).toMatch(/72.hour|soak/i);
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Automation operations" }),
  ).toContainText("Automatic publication is disabled");
  await page.screenshot({
    path: path.join(root, "automation-policy.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
