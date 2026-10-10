import { defineConfig } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const root =
  process.env.CAPY_STUDIO_TEST_ROOT ??
  mkdtempSync(path.join(os.tmpdir(), "capy-studio-e2e-"));
const output = path.join(root, "output");
mkdirSync(output, { recursive: true });
process.env.CAPY_STUDIO_TEST_ROOT = root;
export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  workers: 2,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3031",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node test/fixtures/studio-server.mjs",
    url: "http://127.0.0.1:3031/studio",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      CAPY_DATA_DIR: path.join(root, "data"),
      CAPY_OUTPUT: output,
      CAPY_STUDIO_TEST_ROOT: root,
      CAPY_DISK_RESERVE_BYTES: "0",
      CAPY_AI_ALLOW_CLOUD: "false",
      NODE_OPTIONS: `--experimental-sqlite --import=${JSON.stringify(path.resolve("test/fixtures/subscriptions-preload.mjs"))}`,
    },
  },
});
