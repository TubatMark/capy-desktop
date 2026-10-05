import { describe, expect, it } from "vitest";
import { isEnglish } from "../src/lang";

describe("isEnglish", () => {
  it.each([
    [undefined, true],
    ["en", true],
    ["en-US", true],
    ["en-orig", true],
    ["en_GB", true],
    ["pt-BR", false],
    ["pt", false],
    ["es-orig", false],
    ["eng", false],
  ])("%s → %s", (l, want) => {
    expect(isEnglish(l as string | undefined)).toBe(want);
  });
});
