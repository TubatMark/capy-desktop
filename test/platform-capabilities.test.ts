import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  capabilitiesForAccount,
  nextQuotaReset,
  destinationClientIdentity,
} from "../server/platform-capabilities";
import { runtimeStore } from "../server/db/runtime";
import { httpError } from "../server/platforms/types";
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "capy-capabilities-"));
  process.env.CAPY_DATA_DIR = root;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("documentation and connected credentials do not imply scheduling, thumbnail or automatic eligibility", () => {
  const a = {
    account: { id: "channel", name: "x" },
    tokens: { accessToken: "fake", expiresAt: Date.now() + 10000 },
    clientId: "c",
  };
  expect(capabilitiesForAccount("youtube", a)).toMatchObject({
    connected: true,
    scheduling: "unverified",
    customThumbnail: "unverified",
    automaticPublication: false,
  });
  runtimeStore().put("destination-capabilities", "youtube:channel", {
    accountId: "channel",
    clientIdentity: destinationClientIdentity("youtube", a),
    checkedAt: Date.now(),
    schedulingVerified: true,
  });
  expect(capabilitiesForAccount("youtube", a).scheduling).toBe("verified");
  expect(
    capabilitiesForAccount("youtube", { ...a, clientId: "switched" })
      .scheduling,
  ).toBe("unverified");
  expect(capabilitiesForAccount("tiktok", a).directPublishing).toBe(
    "assisted-only",
  );
});
it("quota, short rate limiting, permission refusal and auth are distinct", () => {
  expect(
    httpError(new Response(null, { status: 403 }), {
      error: { errors: [{ reason: "quotaExceeded" }] },
    }),
  ).toMatchObject({ failureClass: "quota", auth: false, retryable: true });
  expect(
    httpError(
      new Response(null, { status: 429, headers: { "Retry-After": "90" } }),
      {},
    ),
  ).toMatchObject({ failureClass: "rate-limit", retryAfterMs: 90000 });
  expect(httpError(new Response(null, { status: 403 }), {})).toMatchObject({
    failureClass: "permanent",
    auth: false,
  });
  expect(httpError(new Response(null, { status: 401 }), {})).toMatchObject({
    failureClass: "auth",
    auth: true,
  });
});
it("daily quota retry uses Pacific midnight across both DST changes", () => {
  expect(
    new Date(nextQuotaReset(Date.parse("2026-03-08T10:00:00Z"))).toISOString(),
  ).toBe("2026-03-09T07:00:00.000Z");
  expect(
    new Date(nextQuotaReset(Date.parse("2026-11-01T10:00:00Z"))).toISOString(),
  ).toBe("2026-11-02T08:00:00.000Z");
});
