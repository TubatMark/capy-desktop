import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

// Saturday Oct 10 2026, noon in New York
const NOW = Date.UTC(2026, 9, 10, 16, 0);
const shots = path.resolve("test-results/queue-calendar");

const thumb = (hue: number, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 160"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${hue + 30} 55% 32%)"/></linearGradient></defs><rect width="90" height="160" fill="url(#g)"/><text x="8" y="140" font-family="sans-serif" font-size="11" font-weight="700" fill="white">${label}</text></svg>`,
  )}`;

const entry = (n: number, over: Record<string, unknown>) => ({
  key: `j:${n}:youtube`,
  jobId: "j",
  n,
  platform: "youtube",
  status: "scheduled",
  clipTitle: `Clip ${n}`,
  videoTitle: "How capybaras stay calm",
  text: { title: `Clip ${n}` },
  attempts: 0,
  history: [],
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 86_400_000,
  thumbUrl: thumb(20 + n * 25, `CLIP ${n}`),
  ...over,
});

const available = (value: number, unit = "count") => ({
  availability: "available",
  value,
  metric: "m",
  unit,
  source: "youtube-data",
  measuredAt: NOW - 3_600_000,
  window: { kind: "lifetime" },
  definitionVersion: "1",
});
const missing = (reason: string) => ({
  availability: "unavailable",
  reason,
  metric: "m",
  checkedAt: NOW,
});

const entries = [
  // Fri Oct 9, posted and live on YouTube
  entry(1, {
    status: "posted",
    clipTitle: "The calmest animal on earth meets a crocodile",
    text: {
      title: "The calmest animal on earth meets a crocodile",
      description: "Nobody told the capybara to panic.",
      tags: ["capybara", "wildlife"],
    },
    slotAt: Date.UTC(2026, 9, 9, 21, 0),
    result: { id: "vid-posted", url: "https://www.youtube.com/watch?v=vid-posted" },
    aiReview: { verdict: "ok", summary: "Clear hook, safe to post.", issues: [] },
    history: [{ t: Date.UTC(2026, 9, 9, 21, 0), msg: "Posted" }],
  }),
  // Sat Oct 10, scheduled for the afternoon
  entry(2, {
    clipTitle: "Why hot springs are a capybara spa",
    slotAt: Date.UTC(2026, 9, 10, 19, 0),
  }),
  // 03:30 UTC Oct 11 = 11:30 PM Oct 10 in New York: belongs to Saturday
  entry(3, {
    clipTitle: "Late night: the capybara choir",
    slotAt: Date.UTC(2026, 9, 11, 3, 30),
  }),
  // Mon Oct 12, failed
  entry(4, {
    status: "failed",
    clipTitle: "Capybara vs. the lemon",
    error: "YouTube said the upload limit was reached.",
    slotAt: Date.UTC(2026, 9, 12, 20, 0),
  }),
  // waiting for review: never on the calendar
  entry(5, { status: "review", clipTitle: "Still in review" }),
];

async function mock(page: Page) {
  let refreshes = 0;
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/api/queue", (route) =>
    route.fulfill({
      json: {
        entries,
        summary: {},
        audienceTz: "America/New_York",
        capabilities: [],
      },
    }),
  );
  await page.route("**/api/jobs", (route) =>
    route.fulfill({ json: [{ id: "j", channel: "Wild Calm TV" }] }),
  );
  await page.route("**/api/channel/performance", (route) => {
    if (route.request().method() === "POST") refreshes++;
    return route.fulfill({
      json: {
        destinationId: "dest",
        attemptedAt: NOW,
        status: "skipped",
        publications: [
          {
            key: "youtube:dest:vid-posted",
            remoteId: "vid-posted",
            delivery: { id: "delivery-1" },
            attribution: {},
            metrics: {
              views: available(12840),
              likes: available(931),
              comments: available(47),
              analyticsViews: missing("delayed-or-limited"),
              engagedViews: missing("delayed-or-limited"),
              estimatedMinutesWatched: available(2210, "minutes"),
              averageViewDuration: available(21, "seconds"),
              averageViewPercentage: missing("not-returned"),
            },
            remoteChanges: [],
            thumbnailAttribution: "selected-only",
          },
        ],
      },
    });
  });
  return { refreshes: () => refreshes };
}

test("calendar opens on today in the audience zone and lists that day's posts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mock(page);
  await page.goto("/queue");
  const day = page.getByRole("region", { name: "Posts on Saturday, October 10" });
  await expect(day).toBeVisible();
  await expect(day.getByRole("article")).toHaveCount(2);
  await expect(day).toContainText("Why hot springs are a capybara spa");
  // the 11:30 PM New York post stays on Saturday even though it is Sunday in UTC
  await expect(day).toContainText("Late night: the capybara choir");
  await expect(day).toContainText("11:30 PM");
  await expect(day).toContainText("From How capybaras stay calm · Wild Calm TV");
  await expect(page.getByText("Days follow New York time.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "October 2026" })).toBeVisible();
  // review clips never land on the calendar
  await expect(
    page.getByRole("button", { name: /Monday, October 12: 1 needs a look/ }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(shots, "queue-desktop.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("clicking a day shows its posted clips with their numbers", async ({ page }) => {
  await mock(page);
  await page.goto("/queue");
  await page
    .getByRole("button", { name: "Friday, October 9: 1 posted" })
    .click();
  const day = page.getByRole("region", { name: "Posts on Friday, October 9" });
  const card = day.getByRole("article", {
    name: "The calmest animal on earth meets a crocodile",
  });
  await expect(card).toContainText("Views");
  await expect(card).toContainText("12.8K");
  await expect(card).toContainText("931");
  await expect(card).toContainText("47");
  // missing numbers say why instead of showing 0
  await expect(card).toContainText("Avg. watched: YouTube hasn't shared this yet");
  await expect(card.locator("img")).toHaveAttribute("src", /^data:image\/svg/);
});

test("arrow keys move the selected day and Today comes back", async ({ page }) => {
  await mock(page);
  await page.goto("/queue");
  const today = page.getByRole("button", { name: /^Saturday, October 10, today/ });
  await today.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("region", { name: "Posts on Friday, October 9" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Friday, October 9/ }),
  ).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect(page.getByRole("heading", { name: "November 2026" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Posts on Monday, November 9" }),
  ).toContainText("Nothing is planned");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByRole("heading", { name: "October 2026" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Posts on Saturday, October 10" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.getByRole("heading", { name: "November 2026" })).toBeVisible();
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(page.getByRole("heading", { name: "October 2026" })).toBeVisible();
});

test("post details show the text, AI review, results and refresh", async ({ page }) => {
  const m = await mock(page);
  await page.goto("/queue");
  await page.getByRole("button", { name: "Friday, October 9: 1 posted" }).click();
  await page
    .getByRole("button", { name: "The calmest animal on earth meets a crocodile" })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "The calmest animal on earth meets a crocodile",
  });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Nobody told the capybara to panic.");
  await expect(sheet.getByRole("list", { name: "Tags" })).toContainText("wildlife");
  await expect(sheet).toContainText("Clear hook, safe to post.");
  await expect(sheet).toContainText("12.8K");
  await expect(sheet).toContainText("Total minutes watched");
  await expect(sheet.getByRole("link", { name: "Watch on YouTube" })).toHaveAttribute(
    "href",
    "https://www.youtube.com/watch?v=vid-posted",
  );
  await page.waitForTimeout(400); // let the sheet finish sliding in
  await page.screenshot({ path: path.join(shots, "queue-detail.png") });
  await sheet.getByRole("button", { name: "Refresh numbers" }).click();
  await expect.poll(() => m.refreshes()).toBe(1);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("narrow window stacks the calendar above the day list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mock(page);
  await page.goto("/queue");
  const cal = page.getByRole("grid");
  const list = page.getByRole("region", { name: "Posts on Saturday, October 10" });
  await expect(list).toBeVisible();
  const a = (await cal.boundingBox())!;
  const b = (await list.boundingBox())!;
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join(shots, "queue-narrow.png"), fullPage: true });
});
