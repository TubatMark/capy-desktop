import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureWorkerDependencies } from "../scripts/standalone-worker.mjs";

it("worker dependencies resolve after the standalone tree is relocated without repo ancestors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-worker-package-"));
  const standalone = path.join(root, "standalone");
  const scope = path.join(
    standalone,
    "node_modules/.pnpm/sdk-version/node_modules/@anthropic-ai",
  );
  const sdk = path.join(scope, "claude-agent-sdk");
  const native = path.join(scope, "claude-agent-sdk-darwin-arm64");
  mkdirSync(sdk, { recursive: true });
  mkdirSync(native, { recursive: true });
  writeFileSync(
    path.join(sdk, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", main: "sdk.mjs" }),
  );
  writeFileSync(path.join(sdk, "sdk.mjs"), "export const fixture = true;");
  writeFileSync(path.join(native, "claude"), "fixture-cli");
  const before = createRequire(path.join(standalone, "worker.cjs"));
  expect(() => before.resolve("@anthropic-ai/claude-agent-sdk")).toThrow();
  ensureWorkerDependencies(standalone, scope, "darwin", "arm64");
  const packaged = path.join(root, "Capy.app/Contents/Resources/server");
  cpSync(standalone, packaged, { recursive: true, verbatimSymlinks: true });
  const require = createRequire(path.join(packaged, "worker.cjs"));
  const resolved = realpathSync(
    require.resolve("@anthropic-ai/claude-agent-sdk"),
  );
  expect(resolved.startsWith(realpathSync(packaged) + path.sep)).toBe(true);
  expect(
    realpathSync(
      path.join(
        packaged,
        "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
      ),
    ).startsWith(realpathSync(packaged) + path.sep),
  ).toBe(true);
});
