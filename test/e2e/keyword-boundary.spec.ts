import { test, expect } from "@playwright/test";
test("keyword research displays raw results without Strength or historical derived tags", async ({ page }) => {
  await page.route("**/api/channel", (route) => route.fulfill({ json: {
    access: { connected: true, read: true, analytics: true, edit: true },
    snapshot: { channel: { id: "fixture", title: "Fixture channel", description: "", keywords: [] }, videos: [], notes: [], fetchedAt: Date.now() },
  } }));
  let historical = false;
  await page.route("**/api/channel/keywords?*", (route) => route.fulfill({ json: {
    ...(historical ? {} : { rawVersion: 1 }), seed: "topic",
    keywords: [{ term: historical ? "Cached derived phrase" : "Raw suggestion", score: 99, sources: ["autocomplete"] }],
    ranking: [{ id: "zero", title: "Zero views result", channel: "Provider", views: 0 }, { id: "unknown", title: "Unknown views result", channel: "Provider" }],
    tags: ["Cached aggregate tag"], notes: [], at: Date.now(),
  } }));
  await page.goto("/channel");
  await page.getByRole("tab", { name: "Keywords", exact: true }).click();
  await page.getByRole("textbox", { name: "Topic to research" }).fill("topic");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByText("Raw suggestion", { exact: true })).toBeVisible();
  await expect(page.getByText("Provider · 0 views", { exact: true })).toBeVisible();
  await expect(page.getByText("Provider · Views unavailable", { exact: true })).toBeVisible();
  await expect(page.locator('[title^="Strength"]')).toHaveCount(0);
  await expect(page.getByText("Cached aggregate tag", { exact: true })).toHaveCount(0);
  historical = true;
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByText("Raw suggestion", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Cached derived phrase", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Zero views result", { exact: true })).toBeVisible();
});
