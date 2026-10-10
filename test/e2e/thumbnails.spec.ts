import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ThumbnailStudioDocument } from "../../lib/thumbnails";
const root = process.env.CAPY_STUDIO_TEST_ROOT!;
test.beforeAll(() => {
  execFileSync(
    "node",
    [
      "--experimental-sqlite",
      "--import",
      "tsx",
      "test/fixtures/thumbnails/browser-fixture.ts",
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
  );
});
test("no-account local edits, aspect reflow, downloads, history and exact attachment", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/thumbnails/browser-bold");
  await expect(
    page.getByRole("heading", { name: "Thumbnail Studio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Design variations" }).getByRole("button"),
  ).toHaveCount(3);
  await page.getByLabel("Headline", { exact: true }).fill("LOCAL EDIT");
  await page
    .getByRole("combobox", { name: "Font", exact: true })
    .selectOption("Arial");
  await page.getByLabel("headline color", { exact: true }).fill("#ffdd00");
  await page.getByLabel("Crop x", { exact: true }).fill("0.1");
  await page.getByLabel("Crop width", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved locally");
  await page.reload();
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue(
    "LOCAL EDIT",
  );
  await expect(page.getByLabel("Crop width", { exact: true })).toHaveValue(
    "0.8",
  );
  await page
    .getByRole("combobox", { name: "Aspect preset", exact: true })
    .selectOption("portrait");
  await expect(page.getByRole("status")).toContainText(
    "Preset recomposed locally",
  );
  await page.getByLabel("Frame time (seconds)", { exact: true }).fill("1.23");
  await page
    .getByRole("combobox", { name: "Frame source", exact: true })
    .selectOption("finished");
  await page
    .getByRole("button", { name: "Extract selected frame", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Frames ready");
  await page
    .getByRole("region", { name: "Source frames" })
    .getByRole("button")
    .filter({ hasText: /1.17s.*finished/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved locally");
  await page.getByLabel("Include text in download").uncheck();
  const png = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PNG", exact: true }).click();
  const downloaded = await png;
  expect(downloaded.suggestedFilename()).toContain("portrait-no-text.png");
  const downloadPath = await downloaded.path();
  const bytes = readFileSync(downloadPath!);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", downloadPath!],
      { encoding: "utf8" },
    ),
  );
  expect([probe.streams[0].width, probe.streams[0].height]).toEqual([
    1080, 1920,
  ]);
  const zip = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download all ZIP", exact: true })
    .click();
  expect((await zip).suggestedFilename()).toBe("capy-thumbnails.zip");
  await page
    .getByRole("button", { name: "Regenerate background", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /unavailable|disabled|configured/i }),
  ).toContainText(/unavailable|disabled|configured/i, { timeout: 45000 });
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue(
    "LOCAL EDIT",
  );
  await page
    .getByRole("button", { name: "Approve thumbnail version", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Exact thumbnail version reviewed",
  );
  await page
    .getByLabel("Publish package", { exact: true })
    .selectOption("browser-package");
  await page
    .getByRole("button", { name: "Attach selected version", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("needs a new approval");
  const saved = await request.get("/api/thumbnails/browser-bold");
  expect(saved.ok()).toBe(true);
  expect((await saved.json()).history.length).toBe(4);
  await page.screenshot({
    path: testInfo.outputPath("thumbnail-studio.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("frame discovery preserves unsaved headline and crop", async ({
  page,
}) => {
  await page.goto("/thumbnails/browser-editorial");
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("REAL SOURCE");
  await headline.fill("UNSAVED FRAME DRAFT");
  await page.getByLabel("Crop x", { exact: true }).fill("0.1");
  await page.getByLabel("Crop width", { exact: true }).fill("0.8");
  await page
    .getByRole("button", { name: "Suggest frames", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Frames ready");
  await expect(headline).toHaveValue("UNSAVED FRAME DRAFT");
  await expect(page.getByLabel("Crop x", { exact: true })).toHaveValue("0.1");
  await expect(page.getByLabel("Crop width", { exact: true })).toHaveValue(
    "0.8",
  );
  await expect(
    page.getByRole("button", { name: "Save edits", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Frame time (seconds)", { exact: true }).fill("1.23");
  await page
    .getByRole("button", { name: "Extract selected frame", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Frames ready");
  await expect(headline).toHaveValue("UNSAVED FRAME DRAFT");
  await expect(page.getByLabel("Crop width", { exact: true })).toHaveValue(
    "0.8",
  );
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved locally");
  await page.reload();
  await expect(headline).toHaveValue("UNSAVED FRAME DRAFT");
  await expect(page.getByLabel("Crop width", { exact: true })).toHaveValue(
    "0.8",
  );
});

test("busy restore is blocked and cross-aspect restoration saves exact historical pixels", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/thumbnails/browser-minimal");
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue(
    "REAL SOURCE",
  );
  await page
    .getByLabel("Headline", { exact: true })
    .fill("HISTORICAL LANDSCAPE");
  await page.getByLabel("Crop x", { exact: true }).fill("0.1");
  await page.getByLabel("Crop width", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved locally");
  const landscape: ThumbnailStudioDocument = (
    await (await request.get("/api/thumbnails/browser-minimal")).json()
  ).document;
  const before = await (
    await request.get(
      `/api/thumbnails/browser-minimal/export?revision=${landscape.editRevision}&aspect=landscape&format=png&text=true`,
    )
  ).body();
  await page
    .getByRole("combobox", { name: "Aspect preset", exact: true })
    .selectOption("portrait");
  await expect(page.getByRole("status")).toContainText(
    "Preset recomposed locally",
  );

  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route("**/api/thumbnails/browser-minimal", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response });
  });
  await page
    .getByLabel("Headline", { exact: true })
    .fill("PENDING PORTRAIT SAVE");
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await pending;
  const restore = page.getByRole("button", {
    name: new RegExp(`Restore .* · v${landscape.editRevision}$`),
  });
  try {
    await expect(restore).toBeDisabled();
    await restore.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByLabel("Headline", { exact: true })).toHaveValue(
      "PENDING PORTRAIT SAVE",
    );
  } finally {
    release();
  }
  await expect(page.getByRole("status")).toContainText("Saved locally");
  await page.unroute("**/api/thumbnails/browser-minimal");
  await restore.click();
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue(
    "HISTORICAL LANDSCAPE",
  );
  await expect(
    page.getByRole("combobox", { name: "Aspect preset", exact: true }),
  ).toHaveValue("landscape");
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved locally");
  await page.reload();
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue(
    "HISTORICAL LANDSCAPE",
  );
  await expect(page.getByLabel("Crop width", { exact: true })).toHaveValue(
    "0.8",
  );
  const restored: ThumbnailStudioDocument = (
    await (await request.get("/api/thumbnails/browser-minimal")).json()
  ).document;
  expect(restored.layers).toEqual(landscape.layers);
  const after = await (
    await request.get(
      `/api/thumbnails/browser-minimal/export?revision=${restored.editRevision}&aspect=landscape&format=png&text=true`,
    )
  ).body();
  expect(after.equals(before)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("thumbnail-restored-landscape.png"),
    fullPage: true,
  });
});
