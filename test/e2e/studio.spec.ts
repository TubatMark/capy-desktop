import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
const root = process.env.CAPY_STUDIO_TEST_ROOT!;
const source = path.join(root, "fixture.mp4");
test.beforeAll(() => {
  mkdirSync(root, { recursive: true });
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    source,
  ]);
});
test("local import, selection, split, trim, drag snapping, undo redo, autosave, conflict, relink", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/.+/);
  const id = page.url().split("/").at(-1)!;
  await page.getByTestId("media-upload").setInputFiles(source);
  await expect(
    page.getByRole("button", { name: "Add fixture.mp4", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Add fixture.mp4", exact: true })
    .click();
  await expect(page.getByTestId("timeline-item")).toHaveCount(1);
  await page.getByLabel("Playhead frame", { exact: true }).fill("30");
  await page.getByLabel("Playhead frame", { exact: true }).blur();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () =>
      Number(
        await page.getByLabel("Playhead frame", { exact: true }).inputValue(),
      ),
    )
    .toBeGreaterThan(30);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByLabel("Playhead frame", { exact: true }).fill("90");
  await page.getByLabel("Playhead frame", { exact: true }).blur();
  await page.keyboard.press("s");
  await expect(page.getByTestId("timeline-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("timeline-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByTestId("timeline-item")).toHaveCount(2);
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Text shortcut isolation");
  await page.keyboard.press("s");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("timeline-item")).toHaveCount(2);
  await page.getByLabel("Project name", { exact: true }).blur();
  await page.getByTestId("timeline-item").nth(1).click();
  await page.getByLabel("Trim in frames", { exact: true }).fill("30");
  await page.getByLabel("Trim out frames", { exact: true }).fill("180");
  await page.getByRole("button", { name: "Apply trim", exact: true }).click();
  await expect(page.getByLabel("Clip inspector")).toContainText("150 frames");
  await page.getByRole("button", { name: "Move earlier", exact: true }).click();
  await expect(
    page.getByLabel("Clip start frame", { exact: true }),
  ).toHaveValue("0");
  // Move the second clip back to the first clip's edge (within the six-pixel snap tolerance).
  const second = page.getByTestId("timeline-item").nth(1);
  const box = await second.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + 12, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(box!.x + 16, box!.y + 20);
  await page.mouse.up();
  await expect(
    page.getByLabel("Clip start frame", { exact: true }),
  ).toHaveValue("150");
  await expect(page.getByTestId("save-status")).toContainText("Saved", {
    timeout: 20000,
  });
  await page.reload();
  await expect(page.getByTestId("timeline-item")).toHaveCount(2);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await page.getByTestId("timeline-item").first().click();
  await page.getByLabel("Playhead frame", { exact: true }).fill("60");
  await page.getByLabel("Playhead frame", { exact: true }).blur();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("timeline-item")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("timeline-item")).toHaveCount(2);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  const current = await (
    await request.get(`/api/studio/projects/${id}`)
  ).json();
  const newer = { ...current.document, name: "Other window revision" };
  expect(
    (
      await request.put(`/api/studio/projects/${id}`, {
        data: { document: newer, expectedRevision: newer.revision },
      })
    ).status(),
  ).toBe(200);
  await page
    .getByLabel("Project name", { exact: true })
    .fill("My conflicting edit");
  await expect(page.getByTestId("save-status")).toContainText("Save conflict");
  await expect(
    page.getByRole("alert").filter({ hasText: "newer revision" }),
  ).toContainText("newer revision");
  const server = await (await request.get(`/api/studio/projects/${id}`)).json();
  expect(server.document.name).toBe("Other window revision");
  await page
    .getByRole("button", { name: "Reload newer revision", exact: true })
    .click();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Other window revision",
  );
  const assets = await (await request.get("/api/studio/assets")).json();
  const asset = assets.find((a: { name: string }) => a.name === "fixture.mp4");
  const backup = path.join(root, "relink.mp4");
  copyFileSync(asset.location, backup);
  rmSync(asset.location);
  await expect(
    page.getByRole("button", { name: "Relink fixture.mp4", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await page
    .getByRole("button", { name: "Relink fixture.mp4", exact: true })
    .click();
  await page.getByTestId("media-upload").setInputFiles(backup);
  await expect(
    page.getByRole("button", { name: "Add fixture.mp4", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  expect(
    (await (await request.get("/api/studio/assets")).json()).find(
      (a: { id: string }) => a.id === asset.id,
    ).status,
  ).toBe("ready");
  await page.screenshot({
    path: testInfo.outputPath("studio-editor.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("crash draft recovery, revision history, and saving a conflicting copy", async ({
  page,
  request,
}) => {
  const document = await (
    await request.post("/api/studio/projects", {
      data: { name: "Recovery base" },
    })
  ).json();
  await page.goto(`/studio/${document.id}`);
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Recovery base",
  );
  await page.evaluate(
    (d) =>
      localStorage.setItem(
        `capy.studio.draft.${d.id}`,
        JSON.stringify({ ...d, name: "Recovered unsaved draft" }),
      ),
    document,
  );
  await page.reload();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Recovered unsaved draft",
  );
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await page.getByText(/Revision history/, { exact: false }).click();
  await page
    .getByRole("button", { name: "Restore revision 1", exact: true })
    .click();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Recovery base",
  );
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  const current = await (
    await request.get(`/api/studio/projects/${document.id}`)
  ).json();
  expect(
    (
      await request.put(`/api/studio/projects/${document.id}`, {
        data: {
          document: { ...current.document, name: "Other saved edit" },
          expectedRevision: current.document.revision,
        },
      })
    ).status(),
  ).toBe(200);
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Recovered conflicting work");
  await expect(page.getByTestId("save-status")).toContainText("Save conflict");
  await page.getByRole("button", { name: "Save a copy", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(document.id));
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Recovered conflicting work copy",
  );
  expect(
    (await (await request.get(`/api/studio/projects/${document.id}`)).json())
      .document.name,
  ).toBe("Other saved edit");
});
