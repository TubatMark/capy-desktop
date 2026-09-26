import type { NextConfig } from "next";

const config: NextConfig = {
  // The pipeline spawns yt-dlp/ffmpeg and the Claude Agent SDK; keep them out of the bundle.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  images: { remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com" }] },
};

export default config;
