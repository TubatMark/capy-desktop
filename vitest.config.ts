import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// route handlers import through the "@/..." alias from tsconfig.json
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // only our tests: `next build` copies the project (test/ included) into .next/standalone
  test: { include: ["test/**/*.test.ts"] },
});
