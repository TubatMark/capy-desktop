import { test, expect } from "@playwright/test";
const now = Date.now();
const base = {
  key: "j:1:youtube",
  jobId: "j",
  n: 1,
  platform: "youtube",
  status: "needs_action",
  clipTitle: "Delivery fixture",
  text: { title: "Fixture" },
  attempts: 1,
  history: [],
  createdAt: now,
  updatedAt: now,
  slotAt: now,
  publishPackage: { id: "pkg", packageHash: "hash", accountId: "destination" },
  delivery: {
    id: "delivery",
    state: "delivery-unknown",
    visibility: "unknown",
    thumbnail: { status: "unknown" },
    publicationIds: [],
    observedAt: now,
    nextTryAt: now + 60000,
    retryClass: "transient",
    reason: "Remote acceptance uncertain",
  },
};
test("durable outcome and thumbnail are distinct; unknown offers status check instead of retry", async ({
  page,
}) => {
  await page.route("**/api/queue", (route) =>
    route.fulfill({
      json: {
        entries: [base],
        summary: {},
        audienceTz: "UTC",
        capabilities: [],
      },
    }),
  );
  let checks = 0;
  await page.route("**/api/queue/*/check-status", (route) => {
    checks++;
    return route.fulfill({ json: base });
  });
  await page.goto("/queue");
  // the day list shows the plain-language outcome; details open in a side sheet
  await expect(
    page.getByText("YouTube · Not sure it went through").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delivery fixture" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Thumbnail: not confirmed")).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await sheet.getByRole("button", { name: "Check status again" }).click();
  expect(checks).toBe(1);
});
test("remote schedule requires verified capability and explicit acknowledgement", async ({
  page,
}) => {
  const entry = { ...base, status: "scheduled", delivery: undefined };
  let verified = false;
  await page.route("**/api/queue", (route) =>
    route.fulfill({
      json: {
        entries: [entry],
        summary: {},
        audienceTz: "UTC",
        capabilities: [
          {
            platform: "youtube",
            accountId: "destination",
            scheduling: verified ? "verified" : "unverified",
          },
        ],
      },
    }),
  );
  await page.goto("/queue");
  await page.getByRole("button", { name: "Delivery fixture" }).click();
  await page
    .getByText("YouTube upload ahead and remote schedule", { exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve new remote schedule" }),
  ).toBeDisabled();
  verified = true;
  await page.reload();
  await page.getByRole("button", { name: "Delivery fixture" }).click();
  await page
    .getByText("YouTube upload ahead and remote schedule", { exact: true })
    .click();
  await page
    .getByLabel("Publish at (this computer’s time zone)")
    .fill("2026-11-01T12:00");
  await expect(
    page.getByRole("button", { name: "Approve new remote schedule" }),
  ).toBeDisabled();
  await page.getByRole("dialog").getByRole("checkbox").check();
  let payload: unknown;
  await page.route("**/api/queue/*/schedule", (route) => {
    payload = route.request().postDataJSON();
    return route.fulfill({ json: entry });
  });
  await page
    .getByRole("button", { name: "Approve new remote schedule" })
    .click();
  await expect(
    page.getByText("Remote schedule explicitly approved", { exact: true }),
  ).toBeVisible();
  expect(payload).toMatchObject({
    acknowledgeRemoteSchedule: true,
    uploadAheadMinutes: 60,
  });
});
test("post now never fires without an explicit confirmation naming the skipped time", async ({
  page,
}) => {
  const slotAt = Date.UTC(2026, 9, 11, 20, 0); // Sun Oct 11, 4:00 PM New York
  const entry = {
    ...base,
    status: "scheduled",
    delivery: undefined,
    publishPackage: undefined,
    slotAt,
  };
  await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 11, 14, 0)));
  await page.route("**/api/queue", (route) =>
    route.fulfill({
      json: {
        entries: [entry],
        summary: {},
        audienceTz: "America/New_York",
        capabilities: [],
      },
    }),
  );
  let posts = 0;
  await page.route("**/api/queue/*/post-now", (route) => {
    posts++;
    return route.fulfill({ json: entry });
  });
  await page.goto("/queue");
  // no post-now control on the list itself
  await expect(page.getByRole("button", { name: /post now/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Delivery fixture" }).click();
  const sheet = page.getByRole("dialog");
  const postNow = sheet.getByRole("button", { name: "Post now…" });
  await expect(postNow).toBeVisible();
  await postNow.click();
  const confirm = sheet.getByRole("alertdialog");
  await expect(confirm).toContainText(
    "Post now instead of Sun, Oct 11, 4:00 PM EDT (New York)?",
  );
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "test-results/queue-calendar/queue-post-now-confirm.png",
  });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  // Escape backs out of the question, not the sheet
  await postNow.click();
  await page.keyboard.press("Escape");
  await expect(sheet.getByRole("alertdialog")).toHaveCount(0);
  await expect(sheet).toBeVisible();
  expect(posts).toBe(0);
  await postNow.click();
  await sheet.getByRole("button", { name: "Yes, post now" }).click();
  await expect.poll(() => posts).toBe(1);
});
