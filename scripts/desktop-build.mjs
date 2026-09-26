// next build (standalone) -> copy public/ and .next/static into .next/standalone -> bundle main -> electron-builder.
// Usage: node scripts/desktop-build.mjs [--dir]   (--dir packs an unpacked .app into dist/mac-arm64 instead of a dmg)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirOnly = process.argv.includes("--dir");

function run(cmd, args, env = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`${cmd} exited with ${r.status ?? r.signal}`);
    process.exit(r.status ?? 1);
  }
}

const standalone = path.join(root, ".next/standalone");

run("pnpm", ["exec", "next", "build"]);

if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.error(`No standalone server at ${standalone}; is output: "standalone" set in next.config.ts?`);
  process.exit(1);
}

// server.js serves these itself once they sit next to it (see next docs: config/next-config-js/output).
fs.rmSync(path.join(standalone, "public"), { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
fs.rmSync(path.join(standalone, ".next/static"), { recursive: true, force: true });
fs.cpSync(path.join(root, ".next/static"), path.join(standalone, ".next/static"), { recursive: true });

// Sanity: the Claude Agent SDK is external (serverExternalPackages) and must have been traced in, together with the
// native `claude` binary it resolves from its sibling package. pnpm lays these out under node_modules/.pnpm/<pkg>@<ver>/.
// (archiver is bundled into the route chunk, so it needs no node_modules entry.)
const pnpmDir = path.join(standalone, "node_modules/.pnpm");
const sdkParent = fs.existsSync(pnpmDir) ? fs.readdirSync(pnpmDir).find((d) => d.startsWith("@anthropic-ai+claude-agent-sdk@")) : undefined;
const sdkScope = sdkParent ? path.join(pnpmDir, sdkParent, "node_modules/@anthropic-ai") : undefined;
for (const rel of ["claude-agent-sdk/sdk.mjs", `claude-agent-sdk-${process.platform}-${process.arch}/claude`]) {
  const p = sdkScope && path.join(sdkScope, rel);
  if (!p || !fs.existsSync(p)) {
    console.error(`Standalone output is missing @anthropic-ai/${rel}; check outputFileTracingIncludes in next.config.ts.`);
    process.exit(1);
  }
}
fs.chmodSync(path.join(sdkScope, `claude-agent-sdk-${process.platform}-${process.arch}/claude`), 0o755);

// Sanity: every next-server runtime the server chunks require must have been traced in, or the first request to
// that route kills the server with "Cannot find module" (Next 16.3 misses app-route-turbo; see next.config.ts).
const chunksDir = path.join(standalone, ".next/server/chunks");
const needed = new Set();
for (const f of fs.readdirSync(chunksDir)) {
  if (!f.endsWith(".js")) continue;
  for (const m of fs.readFileSync(path.join(chunksDir, f), "utf8").matchAll(/next-server\/([\w-]+\.runtime\.prod\.js)/g)) needed.add(m[1]);
}
const nextParent = fs.existsSync(pnpmDir) ? fs.readdirSync(pnpmDir).find((d) => d.startsWith("next@")) : undefined;
const runtimeDir = nextParent ? path.join(pnpmDir, nextParent, "node_modules/next/dist/compiled/next-server") : undefined;
const missing = [...needed].filter((f) => !runtimeDir || !fs.existsSync(path.join(runtimeDir, f)));
if (missing.length) {
  console.error(`Standalone output is missing next-server runtime(s): ${missing.join(", ")}; add them to outputFileTracingIncludes in next.config.ts.`);
  process.exit(1);
}
console.log(`next-server runtimes present: ${[...needed].join(", ")}`);

const bytes = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += bytes(p);
    else if (e.isFile()) n += fs.statSync(p).size;
  }
  return n;
};
console.log(`standalone server: ${(bytes(standalone) / 1024 / 1024).toFixed(0)} MB`);

run("node", [path.join(root, "scripts/desktop-bundle.mjs")]);

run("pnpm", ["exec", "electron-builder", "--mac", ...(dirOnly ? ["--dir"] : ["dmg"]), "--arm64"], {
  // The app is unsigned (identity: null); make sure no ambient identity is picked up.
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
});
