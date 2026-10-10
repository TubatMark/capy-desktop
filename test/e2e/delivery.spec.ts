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
  await expect(
    page.getByText("youtube · delivery-unknown", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Thumbnail: unknown")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Check saved delivery status" })
    .click();
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
  await page
    .getByText("YouTube upload ahead and remote schedule", { exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve new remote schedule" }),
  ).toBeDisabled();
  verified = true;
  await page.reload();
  await page
    .getByText("YouTube upload ahead and remote schedule", { exact: true })
    .click();
  await page
    .getByLabel("Publish at (this computer’s time zone)")
    .fill("2026-11-01T12:00");
  await expect(
    page.getByRole("button", { name: "Approve new remote schedule" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
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
