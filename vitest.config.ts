import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// route handlers import through the "@/..." alias from tsconfig.json
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // only our tests: `next build` copies the project (test/ included) into .next/standalone
  // some tests render real images, which takes longer than the 5s default when the whole suite runs at once
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, env: { CAPY_NARRATE: "off" } },
});
