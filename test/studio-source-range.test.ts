import { expect, it, vi } from "vitest";
vi.mock("../src/exec", () => ({
  resolveBin: (bin: string) => bin,
  run: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));
import { run } from "../src/exec";
import { fetchSection } from "../src/youtube";
it("the actual downloader command preserves the requested microseconds", async () => {
  await fetchSection(
    "https://www.youtube.com/watch?v=ABCDEFGHIJK",
    1.234567,
    2.234568,
    "/tmp/section.mp4",
  );
  const args = vi.mocked(run).mock.calls[0]![1];
  const index = args.indexOf("--download-sections");
  expect(args[index + 1]).toBe("*1.234567-2.234568");
});
