import { describe, expect, it } from "vitest";
import { WHISPER_NO_MODEL, rankGgmlModels } from "../src/transcribe";

describe("rankGgmlModels", () => {
  it("prefers the large turbo model, then multilingual over english-only and quantised", () => {
    const ranked = rankGgmlModels(["/m/ggml-tiny.bin", "/m/ggml-large-v3-turbo-q5_0.bin", "/m/ggml-large-v3-turbo.bin", "/m/ggml-large-v3-turbo.en.bin", "/m/ggml-medium.bin"]);
    expect(ranked.map((f) => f.split("/").pop())).toEqual(["ggml-large-v3-turbo.bin", "ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo.en.bin", "ggml-medium.bin", "ggml-tiny.bin"]);
  });

  it("ignores files that are not ggml models", () => {
    expect(rankGgmlModels(["/m/README.md", "/m/model.pt", "/m/ggml-base.bin", "/m/.DS_Store"])).toEqual(["/m/ggml-base.bin"]);
  });

  it("puts unknown ggml names after known ones", () => {
    expect(rankGgmlModels(["/m/ggml-custom.bin", "/m/ggml-small.bin"])).toEqual(["/m/ggml-small.bin", "/m/ggml-custom.bin"]);
  });
});

describe("WHISPER_NO_MODEL", () => {
  it("tells the user what is wrong and how to fix it", () => {
    expect(WHISPER_NO_MODEL).toContain("no model file");
    expect(WHISPER_NO_MODEL).toContain("curl -L");
    expect(WHISPER_NO_MODEL).toContain("WHISPER_MODEL");
  });
});
