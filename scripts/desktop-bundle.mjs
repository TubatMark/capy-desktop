// Bundle the Electron main process: electron/main.ts -> dist-electron/main.cjs (CommonJS, since package.json is "type": "module").
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(root, "dist-electron/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "inline",
  logLevel: "info",
});

await build({
  entryPoints: [path.join(root, "server/worker/main.ts")],
  outfile: path.join(root, "dist-electron/worker.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["@anthropic-ai/claude-agent-sdk"],
  logLevel: "info",
});
