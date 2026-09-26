import type { NextConfig } from "next";

const config: NextConfig = {
  // Self-contained server for the Electron shell (scripts/desktop-build.mjs ships .next/standalone as Resources/server).
  output: "standalone",
  // The Electron shell loads http://127.0.0.1:<port> while `next dev` binds localhost; allow HMR across the two.
  allowedDevOrigins: ["127.0.0.1"],
  // The pipeline spawns yt-dlp/ffmpeg and the Claude Agent SDK; keep them out of the bundle.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  // The SDK finds its native `claude` binary with require.resolve("@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")
  // from its own folder, which static tracing cannot see. Include it via the pnpm sibling link so the copy lands
  // exactly where Node resolves it in .next/standalone.
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@*/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**/*",
      // Next 16.3 traces the page runtimes into standalone but not the route runtime the app/api/* chunks require.
      "node_modules/.pnpm/next@*/node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js",
    ],
  },
  // Tracing follows path.resolve("output") into the job output folder (gigabytes of video) and picks up a few
  // dev-only folders; none of these belong in the packaged app.
  outputFileTracingExcludes: {
    "/*": [
      "output/**",
      "docs/**",
      "electron/**",
      "dist-electron/**",
      "dist/**",
      "build/**",
      "scripts/**",
      "test/**",
      ".claude/**",
      ".smoke/**",
      ".ship/**",
      "shots/**",
      "electron-builder.yml",
      "pnpm-lock.yaml",
    ],
  },
  images: { remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com" }] },
};

export default config;
