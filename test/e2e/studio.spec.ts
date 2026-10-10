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

test("paused trim, undo and move seek the edited source mapping", async ({
  page,
  request,
}) => {
  const imported = await (
    await request.post("/api/studio/assets", {
      data: { path: source, kind: "video", name: "preview-regression.mp4" },
    })
  ).json();
  await expect
    .poll(
      async () => {
        const assets = await (await request.get("/api/studio/assets")).json();
        return assets.find((a: { id: string }) => a.id === imported.id)?.status;
      },
      { timeout: 30000 },
    )
    .toBe("ready");
  const document = await (
    await request.post("/api/studio/projects", {
      data: {
        name: "Playback regression",
        sources: [{ assetId: imported.id }, { assetId: imported.id }],
      },
    })
  ).json();
  await page.goto(`/studio/${document.id}`);
  await expect(page.getByTestId("timeline-item")).toHaveCount(2);
  const media = page.locator("video");
  await expect
    .poll(() => media.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThan(0);
  await page.getByLabel("Trim in frames", { exact: true }).fill("30");
  await page.getByLabel("Trim out frames", { exact: true }).fill("300");
  await page.getByRole("button", { name: "Apply trim", exact: true }).click();
  await expect
    .poll(() => media.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeCloseTo(1, 1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(() => media.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeCloseTo(0, 1);
  await page.getByLabel("Playhead frame", { exact: true }).fill("60");
  await expect
    .poll(() => media.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeCloseTo(2, 1);
  await page.getByLabel("Clip start frame", { exact: true }).fill("30");
  await expect
    .poll(() => media.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeCloseTo(1, 1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(() => media.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeCloseTo(2, 1);
});

test("merged playback continues through a full source EOF", async ({
  page,
  request,
}) => {
  const imported = await (
    await request.post("/api/studio/assets", {
      data: { path: source, kind: "video", name: "EOF-a.mp4" },
    })
  ).json();
  const second = await (
    await request.post("/api/studio/assets", {
      data: { path: source, kind: "video", name: "EOF-b.mp4" },
    })
  ).json();
  await expect
    .poll(
      async () => {
        const assets = await (await request.get("/api/studio/assets")).json();
        return [imported.id, second.id].every(
          (id) =>
            assets.find(
              (asset: { id: string; status: string }) => asset.id === id,
            )?.status === "ready",
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  const document = await (
    await request.post("/api/studio/projects", {
      data: {
        name: "EOF playback",
        sources: [{ assetId: imported.id }, { assetId: second.id }],
      },
    })
  ).json();
  await page.goto(`/studio/${document.id}`);
  await expect(page.getByTestId("timeline-item")).toHaveCount(2);
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).readyState),
    )
    .toBeGreaterThan(0);
  // Play from the last half-second of source one through its natural EOF into source two.
  await page.getByLabel("Playhead frame", { exact: true }).fill("285");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () =>
      Number(
        await page.getByLabel("Playhead frame", { exact: true }).inputValue(),
      ),
    )
    .toBeGreaterThan(310);
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
});

test("two editors preserve conflicting recovery when the other window finishes saving", async ({
  page,
  context,
  request,
}) => {
  const document = await (
    await request.post("/api/studio/projects", {
      data: { name: "Window baseline" },
    })
  ).json();
  await page.goto(`/studio/${document.id}`);
  const other = await context.newPage();
  await other.goto(`/studio/${document.id}`);
  await expect(other.getByLabel("Project name", { exact: true })).toHaveValue(
    "Window baseline",
  );
  // Hold only B's successful response after the real server has committed it, so A's draft is newer.
  let deliver!: () => void;
  let committed!: () => void;
  const held = new Promise<void>((resolve) => (deliver = resolve));
  const serverCommitted = new Promise<void>((resolve) => (committed = resolve));
  await other.route(`**/api/studio/projects/${document.id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    committed();
    await held;
    await route.fulfill({ response });
  });
  await other
    .getByLabel("Project name", { exact: true })
    .fill("Window B saved");
  await serverCommitted;
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Window A conflicting recovery");
  deliver();
  await expect(other.getByTestId("save-status")).toContainText("Saved");
  await expect(page.getByTestId("save-status")).toContainText("Save conflict");
  const drafts = await page.evaluate(
    (id) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(`capy.studio.draft.${id}.`))
        .map((key) => JSON.parse(localStorage.getItem(key)!)),
    document.id,
  );
  expect(
    drafts.some((draft) => draft.name === "Window A conflicting recovery"),
  ).toBe(true);
  await page.close({ runBeforeUnload: false });
  const reopened = await context.newPage();
  await reopened.goto(`/studio/${document.id}`);
  await reopened.getByText(/Recoverable edits from other windows/).click();
  await reopened
    .getByRole("button", {
      name: "Recover Window A conflicting recovery",
      exact: true,
    })
    .click();
  await expect(
    reopened.getByLabel("Project name", { exact: true }),
  ).toHaveValue("Window A conflicting recovery");
  await expect(reopened.getByTestId("save-status")).toContainText(
    "Save conflict",
  );
  expect(
    (await (await request.get(`/api/studio/projects/${document.id}`)).json())
      .document.name,
  ).toBe("Window B saved");
});

test("sound volume, caption move, overlay and every undo are visible and durable", async ({
  page,
  request,
}, testInfo) => {
  const sound = path.join(root, "music.wav");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000",
    "-t",
    "2",
    sound,
  ]);
  const imported = await (
    await request.post("/api/studio/assets", {
      data: { path: source, kind: "video", name: "layer-base.mp4" },
    })
  ).json();
  await expect
    .poll(
      async () => {
        const assets = await (await request.get("/api/studio/assets")).json();
        return assets.find((a: { id: string }) => a.id === imported.id)?.status;
      },
      { timeout: 30000 },
    )
    .toBe("ready");
  const document = await (
    await request.post("/api/studio/projects", {
      data: { name: "B3 mix and layers", sources: [{ assetId: imported.id }] },
    })
  ).json();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/studio/${document.id}`);
  await page.getByTestId("media-upload").setInputFiles(sound);
  await page
    .getByRole("button", { name: "Add music.wav", exact: true })
    .click();
  await expect(page.getByTestId("timeline-item")).toHaveCount(2);
  await expect(page.getByLabel("Audio gain dB", { exact: true })).toHaveValue(
    "0",
  );
  await page.getByLabel("Audio gain dB", { exact: true }).fill("-6");
  await expect(page.getByLabel("Audio gain dB", { exact: true })).toHaveValue(
    "-6",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Audio gain dB", { exact: true })).toHaveValue(
    "0",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("timeline-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page
    .getByTestId("timeline-item")
    .filter({ hasText: "music.wav" })
    .click();
  await expect(page.getByTestId("audio-waveform").first()).toBeVisible({
    timeout: 15000,
  });
  await page.getByLabel("Audio gain dB", { exact: true }).fill("-6");
  await page.getByLabel("Loop sound", { exact: true }).check();
  await page.getByLabel("Sound duration frames", { exact: true }).fill("120");
  await expect(
    page.getByLabel("Sound duration frames", { exact: true }),
  ).toHaveValue("120");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByLabel("Sound duration frames", { exact: true }),
  ).toHaveValue("60");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByLabel("Loop sound", { exact: true }),
  ).not.toBeChecked();
  await page.getByLabel("Playhead frame", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByTestId("studio-audio-preview")
        .last()
        .evaluate((audio) => (audio as HTMLAudioElement).volume),
    )
    .toBeCloseTo(1 / 3, 2);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByLabel("Playhead frame", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Add caption", exact: true }).click();
  await expect(page.getByTestId("timeline-caption")).toHaveCount(1);
  await page.getByLabel("Caption text", { exact: true }).fill("Edited caption");
  await page.getByLabel("Caption start frame", { exact: true }).fill("12");
  await page
    .getByLabel("Caption vertical position", { exact: true })
    .fill("0.7");
  await page
    .getByRole("button", { name: "Apply caption", exact: true })
    .click();
  await page.getByLabel("Playhead frame", { exact: true }).fill("12");
  await expect(page.getByTestId("preview-caption")).toHaveText(
    "Edited caption",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByLabel("Caption start frame", { exact: true }),
  ).toHaveValue("0");
  await expect(page.getByTestId("preview-caption")).toHaveText("New caption");
  await page
    .getByRole("button", { name: "Add title overlay", exact: true })
    .click();
  await expect(page.getByTestId("timeline-item")).toHaveCount(3);
  await expect(page.getByTestId("preview-layer")).toContainText("Your title");
  await page.getByLabel("Title text", { exact: true }).fill("Actual overlay");
  await page.getByRole("button", { name: "Apply title", exact: true }).click();
  await expect(page.getByTestId("preview-layer")).toContainText(
    "Actual overlay",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("preview-layer")).toContainText("Your title");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("preview-layer")).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.getByLabel("Show safe areas", { exact: true }).check();
  await expect(page.getByTestId("preview-safe-area")).toBeVisible();
  await expect(page.getByTestId("save-status")).toContainText("Saved", {
    timeout: 20000,
  });
  await page.reload();
  await expect(page.getByTestId("timeline-item")).toHaveCount(3);
  await expect(page.getByTestId("timeline-caption")).toHaveCount(1);
  await page.getByLabel("Playhead frame", { exact: true }).fill("12");
  await expect(page.getByTestId("preview-layer")).toContainText("Your title");
  await expect(page.getByTestId("preview-caption")).toHaveText("New caption");
  await page.screenshot({
    path: testInfo.outputPath("b3-audio-captions-layers.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
