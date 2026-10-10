import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const root = process.env.CAPY_STUDIO_TEST_ROOT!;
test.beforeAll(() =>
  execFileSync(
    "node",
    [
      "--experimental-sqlite",
      "--import",
      "tsx",
      "test/fixtures/performance/browser-fixture.ts",
    ],
    {
      env: {
        ...process.env,
        CAPY_DATA_DIR: path.join(root, "data"),
        CAPY_OUTPUT: path.join(root, "output"),
        CAPY_AI_ALLOW_CLOUD: "false",
      },
      stdio: "pipe",
    },
  ),
);
test("raw cached publication results, explicit uncertainty and scoped deletion use real local APIs", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/channel");
  await page.getByRole("tab", { name: "Clip results", exact: true }).click();
  const panel = page.getByRole("region", { name: "Clip results" }),
    publication = panel.getByRole("article", {
      name: "Publication performance-remote",
    });
  await expect(publication).toContainText("Engaged views");
  await expect(publication).toContainText("125%");
  await expect(publication).toContainText("This value was not returned");
  await expect(publication).toContainText("source performance-source");
  await expect(publication).toContainText("rendered 1.00s");
  await expect(panel).toContainText("Performance improvement is unproven");
  const data = JSON.parse(
    readFileSync(path.join(root, "performance-fixture.json"), "utf8"),
  );
  const before = await (
    await request.get(`/api/channel/performance?recipe=${data.recipeId}`)
  ).json();
  expect(before.publications).toHaveLength(1);
  expect(before.publications[0].attribution.packageHash).toBe(data.packageHash);
  expect(before.publications[0].metrics.views).toMatchObject({
    availability: "available",
    value: 0,
  });
  await publication
    .getByRole("button", { name: "Thumbnail changed on YouTube", exact: true })
    .click();
  await expect(publication).toContainText("Remote change reported");
  await expect(publication).toContainText("exact change time unknown");
  await page.screenshot({
    path: path.join(root, "clip-performance.png"),
    fullPage: true,
  });
  await panel
    .getByRole("button", { name: "Delete cached results", exact: true })
    .click();
  await expect(publication).toContainText("Not refreshed yet");
  const after = await (await request.get("/api/channel/performance")).json();
  expect(after.publications[0].attribution.packageHash).toBe(data.packageHash);
  expect(after.publications[0].remoteChanges).toHaveLength(1);
  expect(after.publications[0].metrics.views.availability).toBe("unavailable");
  expect(errors).toEqual([]);
});
test("Capy template suggestion changes only the draft until explicit creator recipe save", async ({
  page,
  request,
}) => {
  await page.goto("/automation");
  const panel = page.getByRole("region", { name: "Automation operations" });
  const creator = panel
    .getByText("Performance creator", { exact: true })
    .locator("..");
  await creator.getByText("Creator recipe and capacity", { exact: true }).click();
  const before = await (await request.get("/api/automation/health")).json();
  const old = before.policies["performance-creator"].recipeId;
  await creator
    .getByRole("button", { name: "Use Clean in recipe draft", exact: true })
    .click();
  await expect(creator.getByLabel("Edit template")).toHaveValue(
    "clean-portrait-v1",
  );
  const unsaved = await (await request.get("/api/automation/health")).json();
  expect(unsaved.policies["performance-creator"].recipeId).toBe(old);
  await creator
    .getByRole("button", { name: "Save creator recipe", exact: true })
    .click();
  await expect(creator).toContainText("Saved recipe version:");
  const after = await (await request.get("/api/automation/health")).json();
  expect(after.policies["performance-creator"].recipeId).not.toBe(old);
  expect(after.policies["performance-creator"].mode).toBe("automatic_drafts");
  expect(after.controls.globalStop).toBe(true);
  const original = await (
    await request.get(`/api/channel/performance?recipe=${old}`)
  ).json();
  expect(original.publications).toHaveLength(1);
  expect(
    original.publications[0].attribution.recipe.definition.editTemplate,
  ).toBe("bold-portrait-v1");
  await page.screenshot({
    path: path.join(root, "clip-performance-manual-draft.png"),
    fullPage: true,
  });
});
