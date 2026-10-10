import { test, expect } from "@playwright/test";
import { DEFAULT_AI_ROUTING } from "../../lib/ai-policy";
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => {
  expect(
    (
      await request.put("/api/settings", {
        data: {
          agent: "claude",
          aiRouting: { ...DEFAULT_AI_ROUTING, tasks: {} },
        },
      })
    ).status(),
  ).toBe(200);
});
test("adapter-only and premium edits populate defaults; privacy limits save with no blank escalation", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/settings");
  const panel = page.getByRole("region", {
    name: "AI task routing and limits",
  });
  await panel
    .getByLabel("metadata adapter", { exact: true })
    .selectOption("codex");
  await expect(panel.getByLabel("metadata model", { exact: true })).toHaveValue(
    "gpt-6-luna",
  );
  await panel.getByLabel("Daily reserved USD", { exact: true }).fill("0.5");
  await panel.getByLabel("Allow cloud calls", { exact: true }).uncheck();
  await expect(
    panel.getByRole("button", {
      name: "Enable metadata escalation",
      exact: true,
    }),
  ).toBeDisabled();
  await panel
    .getByRole("button", { name: "Save AI routing", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText("Saved");
  const saved = (await (await request.get("/api/settings")).json()).settings
    .aiRouting;
  expect(saved).toMatchObject({
    allowCloud: false,
    maxDayUsd: 0.5,
    tasks: { metadata: { agent: "codex", model: "gpt-6-luna" } },
  });
  expect(saved.tasks.metadata.escalation).toBeUndefined();
  await page.reload();
  await expect(panel.getByLabel("metadata model", { exact: true })).toHaveValue(
    "gpt-6-luna",
  );
  await expect(
    panel.getByLabel("Daily reserved USD", { exact: true }),
  ).toHaveValue("0.5");
  await expect(panel).toContainText("Actual provider requests: unknown");
  await panel
    .getByLabel("AI usage limit mode", { exact: true })
    .selectOption("provider");
  await expect(panel).toContainText("model calls are blocked");
  await panel
    .getByLabel("AI usage limit mode", { exact: true })
    .selectOption("application");
  const reviewRow = panel
    .getByLabel("review adapter", { exact: true })
    .locator("..")
    .locator("..");
  await reviewRow
    .getByLabel("Explicitly allow premium for this task", { exact: true })
    .check();
  await expect(panel.getByLabel("review model", { exact: true })).toHaveValue(
    "claude-haiku-5-5",
  );
  await panel
    .getByRole("button", { name: "Save AI routing", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText("Saved");
  await panel.getByLabel("Allow cloud calls", { exact: true }).check();
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByTestId("ai-active-policy")).toContainText(
    "cloud calls disabled",
  );
  await page.screenshot({
    path: testInfo.outputPath("ai-settings-defaults.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("a rejected routing save never reports Saved and restores last confirmed policy", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/settings");
  const panel = page.getByRole("region", {
    name: "AI task routing and limits",
  });
  await expect(panel.getByTestId("ai-active-policy")).toContainText(
    "cloud calls allowed",
  );
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture persistence failure" }),
      });
    else await route.continue();
  });
  await panel.getByLabel("Allow cloud calls", { exact: true }).uncheck();
  await panel.getByLabel("Daily reserved USD", { exact: true }).fill("0.1");
  await panel
    .getByRole("button", { name: "Save AI routing", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText(
    "Fixture persistence failure",
  );
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(
    panel.getByLabel("Allow cloud calls", { exact: true }),
  ).toBeChecked();
  await expect(panel.getByTestId("ai-active-policy")).toContainText(
    "cloud calls allowed",
  );
  expect(
    (await (await request.get("/api/settings")).json()).settings.aiRouting
      .allowCloud,
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("ai-settings-rejected-save.png"),
    fullPage: true,
  });
});
