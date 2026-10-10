import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveBin } from "../../src/exec";
const root = process.env.CAPY_STUDIO_TEST_ROOT!,
  source = path.join(root, "export-source.mp4");
test.beforeAll(() => {
  mkdirSync(root, { recursive: true });
  execFileSync(resolveBin("ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x180:r=24:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=44100:duration=2",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    source,
  ]);
});
test("account-free worker export, exact rendered preview/download, reopened history and stale review rejection", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const imported = await (
    await request.post("/api/studio/assets", {
      data: { path: source, kind: "video" },
    })
  ).json();
  expect(imported.id).toBeTruthy();
  await expect
    .poll(
      async () => {
        const all = await (await request.get("/api/studio/assets")).json();
        return all.find((a: any) => a.id === imported.id)?.status;
      },
      { timeout: 30000 },
    )
    .toBe("ready");
  const project = await (
    await request.post("/api/studio/projects", {
      data: {
        name: "Export browser fixture",
        sources: [{ assetId: imported.id }],
      },
    })
  ).json();
  project.captionCues = [
    {
      id: "caption",
      startFrame: 15,
      durationFrames: 15,
      text: "Rendered caption",
      fontSize: 64,
      x: 0.5,
      y: 0.8,
    },
  ];
  const saved = await (
    await request.put(`/api/studio/projects/${project.id}`, {
      data: { document: project, expectedRevision: project.revision },
    })
  ).json();
  await page.goto(`/studio/${project.id}`);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await page.getByLabel("Footage fit", { exact: true }).selectOption("cover");
  await page.getByLabel("Footage color", { exact: true }).selectOption("warm");
  await page.getByLabel("Footage crop percent", { exact: true }).fill("20");
  await page.getByLabel("Footage crop percent", { exact: true }).blur();
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await page
    .getByRole("button", { name: "Render export", exact: true })
    .click();
  await expect(page.getByTestId("normalized-preview")).toBeVisible({
    timeout: 60000,
  });
  const state = await (
    await request.get(`/api/studio/projects/${project.id}/render`)
  ).json();
  const artifact = state.artifacts[0];
  expect(artifact.probe).toMatchObject({
    width: 1080,
    height: 1920,
    hasAudio: true,
    fps: { numerator: 30, denominator: 1 },
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download MP4", exact: true }).click();
  const download = await downloadPromise;
  const downloaded = info.outputPath("download.mp4");
  await download.saveAs(downloaded);
  expect(
    createHash("sha256").update(readFileSync(downloaded)).digest("hex"),
  ).toBe(artifact.checksum);
  for (const frame of [14, 15, 29, 30]) {
    const browser = await page
      .getByTestId("normalized-preview")
      .evaluate(async (el, n) => {
        const video = el as HTMLVideoElement;
        video.pause();
        video.currentTime = (n + 0.1) / 30;
        await new Promise<void>((resolve) =>
          video.addEventListener("seeked", () => resolve(), { once: true }),
        );
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(video, 0, 0, 64, 64);
        return [...ctx.getImageData(0, 0, 64, 64).data];
      }, frame);
    const reference = execFileSync(resolveBin("ffmpeg"), [
      "-v",
      "error",
      "-i",
      downloaded,
      "-vf",
      `select=eq(n\\,${frame}),scale=64:64`,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    let difference = 0;
    for (let n = 0; n < 4096; n++)
      for (let c = 0; c < 3; c++)
        difference += Math.abs(browser[n * 4 + c]! - reference[n * 3 + c]!);
    expect(difference / (4096 * 3)).toBeLessThan(10);
  }
  await page.screenshot({
    path: info.outputPath("b4-normalized-export.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByTestId("normalized-preview")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download MP4", exact: true }),
  ).toBeVisible();
  await page.getByText("Prepare publication review", { exact: true }).click();
  await page
    .getByLabel("Publication text", { exact: true })
    .fill("Local draft");
  await page
    .getByRole("button", { name: "Prepare review", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Open review queue", exact: true }),
  ).toBeVisible();
  const queue = await (await request.get("/api/queue")).json();
  expect(JSON.stringify(queue)).toContain(artifact.id);
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Changed revision");
  await page.getByLabel("Project name", { exact: true }).blur();
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await expect(
    page.getByRole("button", { name: "Prepare review", exact: true }),
  ).toBeDisabled();
  const stale = await request.post(
    `/api/studio/projects/${project.id}/render/${artifact.id}/review`,
    {
      data: {
        checksum: artifact.checksum,
        platform: "youtube",
        text: { title: "old" },
      },
    },
  );
  expect(stale.ok()).toBe(false);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "/tmp/capy-b7-render-evidence/advanced-browser.png",
    fullPage: true,
  });
});

test("advanced edits are reversible and microphone recordings create assets only after acceptance", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const imported = await (
    await request.post("/api/studio/assets", {
      data: { path: source, kind: "video" },
    })
  ).json();
  await expect
    .poll(async () => {
      const all = await (await request.get("/api/studio/assets")).json();
      return all.find((a: any) => a.id === imported.id)?.status;
    })
    .toBe("ready");
  const doc = await (
    await request.post("/api/studio/projects", {
      data: {
        name: "Advanced browser fixture",
        sources: [{ assetId: imported.id }],
      },
    })
  ).json();
  await page.goto(`/studio/${doc.id}`);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await page.getByLabel("Playback speed", { exact: true }).selectOption("2");
  await expect(page.getByLabel("Playback speed", { exact: true })).toHaveValue(
    "2",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Playback speed", { exact: true })).toHaveValue(
    "1",
  );
  await page
    .getByRole("button", {
      name: "Freeze at playhead · 2 seconds · silence",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Playback speed", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByLabel("Playback speed", { exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Template text", { exact: true }).fill("Local callout");
  await page.getByLabel("Template placement").selectOption("callout");
  await page
    .getByRole("button", { name: "Apply local motion template", exact: true })
    .click();
  await expect(page.getByTestId("preview-layer")).toContainText(
    "Local callout",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("preview-layer")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add beat marker at playhead", exact: true })
    .click();
  await expect(page.getByLabel("Beat markers")).toContainText("Beat 1");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Beat markers")).toHaveCount(0);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await page
    .getByLabel("Reframe fallback", { exact: true })
    .selectOption("cover");
  await page
    .getByRole("button", { name: "Suggest reframe", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Accept suggested edit", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Accept suggested edit", exact: true })
    .click();
  await expect(page.getByLabel("Footage fit", { exact: true })).toHaveValue(
    "cover",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Footage fit", { exact: true })).toHaveValue(
    "contain",
  );
  await page.getByLabel("Playback speed", { exact: true }).selectOption("2");
  await page
    .getByLabel("Template text", { exact: true })
    .fill("Advanced rendered motion");
  await page
    .getByRole("button", { name: "Apply local motion template", exact: true })
    .click();
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await page
    .getByRole("button", { name: "Render export", exact: true })
    .click();
  await expect(page.getByTestId("normalized-preview")).toBeVisible({
    timeout: 60000,
  });
  const advancedRender = await (
    await request.get(`/api/studio/projects/${doc.id}/render`)
  ).json();
  expect(advancedRender.artifacts[0].rendererVersion).toBe("ffmpeg-studio-4");
  expect(advancedRender.artifacts[0].probe.durationUs).toBe(2000000);
  const assetCount = async () =>
    ((await (await request.get("/api/studio/assets")).json()) as unknown[])
      .length;
  const before = await assetCount();
  // Deterministic fixture stream still exercises real MediaRecorder and WAV decoding.
  await page.evaluate(() => {
    const media = navigator.mediaDevices;
    Object.defineProperty(media, "getUserMedia", {
      configurable: true,
      value: async () => {
        throw new DOMException(
          "Microphone permission denied",
          "NotAllowedError",
        );
      },
    });
  });
  await page
    .getByRole("button", { name: "Record voiceover", exact: true })
    .click();
  await expect(
    page.getByLabel("Voice recording").getByRole("alert"),
  ).toContainText("Microphone permission denied");
  expect(await assetCount()).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const audio = new AudioContext(),
          osc = audio.createOscillator(),
          target = audio.createMediaStreamDestination();
        osc.frequency.value = 440;
        osc.connect(target);
        osc.start();
        const track = target.stream.getAudioTracks()[0]!;
        const stop = track.stop.bind(track);
        track.stop = () => {
          osc.stop();
          void audio.close();
          stop();
        };
        return target.stream;
      },
    });
  });
  await page
    .getByRole("button", { name: "Record voiceover", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await page
    .getByRole("button", { name: "Cancel recording", exact: true })
    .click();
  expect(await assetCount()).toBe(before);
  await page
    .getByRole("button", { name: "Record voiceover", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(450);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(page.getByLabel("Recorded voice preview")).toBeVisible();
  expect(await assetCount()).toBe(before);
  await page
    .getByRole("button", { name: "Accept recording as new asset", exact: true })
    .click();
  await expect.poll(assetCount).toBe(before + 1);
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "/tmp/capy-b7-render-evidence/advanced-browser.png",
    fullPage: true,
  });
});
