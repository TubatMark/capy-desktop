import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Next traces pnpm packages without necessarily tracing the root aliases the sidecar requires. */
export function ensureWorkerDependencies(
  standalone,
  sdkScope,
  platform = process.platform,
  arch = process.arch,
) {
  const scope = path.join(standalone, "node_modules", "@anthropic-ai");
  fs.mkdirSync(scope, { recursive: true });
  for (const name of [
    "claude-agent-sdk",
    `claude-agent-sdk-${platform}-${arch}`,
  ]) {
    const source = path.join(sdkScope, name);
    if (!fs.existsSync(source))
      throw Error(`Missing worker dependency ${source}`);
    const alias = path.join(scope, name);
    if (!fs.existsSync(alias))
      fs.symlinkSync(path.relative(scope, source), alias, "dir");
  }
  const require = createRequire(path.join(standalone, "worker.cjs"));
  const resolved = require.resolve("@anthropic-ai/claude-agent-sdk");
  if (
    !fs
      .realpathSync(resolved)
      .startsWith(fs.realpathSync(standalone) + path.sep)
  )
    throw Error("Worker SDK resolves outside standalone output");
  const binary = path.join(
    scope,
    `claude-agent-sdk-${platform}-${arch}`,
    "claude",
  );
  if (!fs.existsSync(binary)) throw Error(`Missing worker CLI ${binary}`);
  return { resolved, binary };
}
