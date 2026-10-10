import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

// Sunday Oct 11 2026, noon in New York
const NOW = Date.UTC(2026, 9, 11, 16, 0);
const shots = path.resolve("test-results/similar-clips");

const thumb = (hue: number, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 160"><rect width="90" height="160" fill="hsl(${hue} 60% 45%)"/><text x="8" y="140" font-family="sans-serif" font-size="11" font-weight="700" fill="white">${label}</text></svg>`,
  )}`;

const TITLES: Record<number, string> = {
  1: "$500 2K wager",
  2: "Gets Raided Mid-Wager",
  3: "Goes Up in $500 2K Wager",
  4: "Calls Out Rival",
  5: "How to repot a cactus",
};
const ref = (n: number, state: string) => ({
  id: `speed:${n}`,
  score: 0.8,
  reasons: ["Cut from the same video"],
  title: TITLES[n],
  state,
  link: `/v/speed/clip/${n}`,
  thumbUrl: thumb(n * 40, `#${n}`),
});
const REC = "Post only the strongest one: '$500 2K wager'; reject the others.";
const opinion = (by: string, level: string, similarTo: string[], why: string, recommendation = REC) => ({
  by,
  level,
  similarTo,
  why,
  recommendation,
});
const checked = (over: Record<string, unknown>) => ({
  checkedAt: NOW - 60_000,
  setHash: "h",
  unavailable: [],
  ...over,
});

const entry = (n: number, over: Record<string, unknown>) => ({
  key: `speed:${n}:youtube`,
  jobId: n === 5 ? "plants" : "speed",
  n,
  platform: "youtube",
  status: "review",
  clipTitle: TITLES[n],
  videoTitle: n === 5 ? "Plant care" : "IShowSpeed plays NBA 2K for $500",
  text: { title: TITLES[n] },
  attempts: 0,
  history: [],
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 3_600_000,
  thumbUrl: thumb(n * 40, `#${n}`),
  ...over,
});

const entries = [
  // both AIs agree: near-duplicate of 2, 3 and the posted 4
  entry(1, {
    similarity: checked({
      candidates: [ref(2, "waiting"), ref(3, "waiting"), ref(4, "posted")],
      opinions: [
        opinion("claude", "near-duplicate", ["speed:2", "speed:3", "speed:4"], "Same stream, same wager, same desk setup."),
        opinion("codex", "near-duplicate", ["speed:2", "speed:3"], "Viewers would see the same 2K wager twice."),
      ],
      verdict: { level: "near-duplicate", agreement: "agree", similarTo: ["speed:2", "speed:3", "speed:4"], why: "Same stream.", recommendation: REC },
    }),
  }),
  // Codex was unavailable: Claude alone
  entry(2, {
    jobId: "speed",
    similarity: checked({
      candidates: [ref(1, "waiting"), ref(3, "waiting")],
      opinions: [opinion("claude", "near-duplicate", ["speed:1", "speed:3"], "The raid happens during the same wager.")],
      unavailable: [{ by: "codex", reason: "Codex isn't installed on this computer" }],
      verdict: { level: "near-duplicate", agreement: "single", similarTo: ["speed:1", "speed:3"], why: "x", recommendation: REC },
    }),
  }),
  // the AIs disagree
  entry(3, {
    similarity: checked({
      candidates: [ref(1, "waiting")],
      opinions: [
        opinion("claude", "near-duplicate", ["speed:1"], "Same wager moment, different title.", REC),
        opinion("codex", "similar", ["speed:1"], "Same stream but a later moment.", "Space them at least 2 days apart."),
      ],
      verdict: { level: "near-duplicate", agreement: "differ", similarTo: ["speed:1"], why: "x", recommendation: REC },
    }),
  }),
  // posted three days ago
  entry(4, {
    status: "posted",
    slotAt: Date.UTC(2026, 9, 8, 21, 0),
    result: { id: "vid-4", url: "https://www.youtube.com/watch?v=vid-4" },
    similarity: checked({
      candidates: [ref(1, "waiting")],
      opinions: [
        opinion("claude", "similar", ["speed:1"], "Same stream as the $500 wager clip.", "Space them at least 2 days apart."),
        opinion("codex", "similar", ["speed:1"], "Same stream, different moment.", "Space them at least 2 days apart."),
      ],
      verdict: { level: "similar", agreement: "agree", similarTo: ["speed:1"], why: "x", recommendation: "Space them at least 2 days apart." },
    }),
  }),
  // nothing close
  entry(5, {
    key: "plants:5:youtube",
    similarity: checked({ candidates: [], opinions: [], verdict: { level: "distinct", agreement: "none", similarTo: [] } }),
  }),
];

async function mock(page: Page) {
  const rechecks: string[] = [];
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/api/queue", (route) =>
    route.fulfill({ json: { entries, summary: {}, audienceTz: "America/New_York", capabilities: [] } }),
  );
  await page.route("**/api/queue/*/similarity", (route) => {
    rechecks.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]!));
    return route.fulfill({ status: 202, json: entries[0] });
  });
  await page.route("**/api/jobs", (route) => route.fulfill({ json: [{ id: "speed", channel: "IShowSpeed" }] }));
  await page.route("**/api/channel/performance", (route) =>
    route.fulfill({ json: { destinationId: "dest", attemptedAt: NOW, status: "skipped", publications: [] } }),
  );
  return { rechecks };
}

const card = (page: Page, n: number) => page.locator(`[id="review-${n === 5 ? "plants" : "speed"}:${n}"]`);

test("waiting clips show both AIs' similar-clip verdicts, the linked clips and the recommendation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mock(page);
  await page.goto("/queue");

  const box = card(page, 1).getByRole("region", { name: "Similar clips" });
  await expect(box).toContainText("Similar clips: Nearly the same as 3 other clips");
  await expect(box).toContainText(`AI recommends: ${REC}`);
  await expect(box).toContainText("Claude and Codex agree.");
  await expect(box.getByLabel("Claude's opinion")).toContainText("Same stream, same wager, same desk setup.");
  await expect(box.getByLabel("Codex's opinion")).toContainText("Viewers would see the same 2K wager twice.");
  const linked = box.getByRole("list", { name: "Linked clips" });
  await expect(linked.getByRole("listitem")).toHaveCount(3);
  await expect(linked).toContainText("Gets Raided Mid-Wager");
  await expect(linked).toContainText("Waiting for your OK");
  await expect(linked).toContainText("Posted");
  await expect(linked.locator("img")).toHaveCount(3);

  // nothing close: a short all-clear line, no box
  await expect(card(page, 5)).toContainText("Looks different from your other clips");
  await expect(card(page, 5).getByRole("region", { name: "Similar clips" })).toHaveCount(0);

  // group hint above the list
  const hint = page.getByRole("note").filter({ hasText: "look nearly the same" });
  await expect(hint).toContainText("3 clips waiting look nearly the same");
  await expect(hint).toContainText(REC);
  await card(page, 1).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, "review-card.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a missing second opinion and a disagreement are said plainly", async ({ page }) => {
  await mock(page);
  await page.goto("/queue");
  const single = card(page, 2).getByRole("region", { name: "Similar clips" });
  await expect(single).toContainText("Only Claude answered; the second opinion was unavailable.");
  await expect(single.getByLabel("Codex's opinion")).toContainText(
    "Second opinion unavailable: Codex isn't installed on this computer.",
  );
  const differ = card(page, 3).getByRole("region", { name: "Similar clips" });
  await expect(differ).toContainText("Claude and Codex disagree");
  await expect(differ.getByLabel("Claude's opinion")).toContainText("Nearly the same");
  await expect(differ.getByLabel("Codex's opinion")).toContainText("Similar");
  await expect(differ.getByLabel("Codex's opinion")).toContainText("Space them at least 2 days apart.");
  // approval is never blocked by the check
  await expect(card(page, 3).getByRole("button", { name: "Approve" })).toBeEnabled();
});

test("linked clips open: a posted one in the post panel (with its own verdict), a waiting one scrolls into view", async ({ page }) => {
  await mock(page);
  await page.goto("/queue");
  const linked = card(page, 1).getByRole("list", { name: "Linked clips" });
  await linked.getByRole("button", { name: /Calls Out Rival/ }).click();
  const sheet = page.getByRole("dialog", { name: "Calls Out Rival" });
  await expect(sheet).toBeVisible();
  const box = sheet.getByRole("region", { name: "Similar clips" });
  await expect(box).toContainText("Similar to 1 other clip");
  await expect(box).toContainText("AI recommends: Space them at least 2 days apart.");
  await page.screenshot({ path: path.join(shots, "post-detail.png") });
  // from the panel, the waiting clip it resembles is one click away
  await box.getByRole("button", { name: /\$500 2K wager/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(card(page, 1)).toBeInViewport();
});

test("Check again asks the server to compare the clip again", async ({ page }) => {
  const m = await mock(page);
  await page.goto("/queue");
  await card(page, 1).getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "compare this clip again" })).toBeVisible();
  expect(m.rechecks).toEqual(["speed:1:youtube"]);
});
