import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { homedir } from "node:os";
import { ensureToolPaths } from "../src/exec";

const FIXED = ["/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local", "bin")];

describe("ensureToolPaths", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PATH;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  });

  it("prepends the tool folders to a minimal PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    const out = ensureToolPaths();
    const parts = out.split(path.delimiter);
    for (const d of FIXED) expect(parts).toContain(d);
    // prepended, not appended: everything we added comes before the original entries
    expect(parts.indexOf("/usr/bin")).toBeGreaterThan(parts.indexOf("/opt/homebrew/bin"));
    expect(parts.slice(-2)).toEqual(["/usr/bin", "/bin"]);
    expect(process.env.PATH).toBe(out);
  });

  it("is idempotent", () => {
    process.env.PATH = "/usr/bin:/bin";
    const once = ensureToolPaths();
    const twice = ensureToolPaths();
    expect(twice).toBe(once);
    const parts = twice.split(path.delimiter);
    for (const d of FIXED) expect(parts.filter((p) => p === d)).toHaveLength(1);
  });

  it("only prepends what is missing and keeps the existing order", () => {
    process.env.PATH = ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/bin"].join(path.delimiter);
    const parts = ensureToolPaths().split(path.delimiter);
    expect(parts.filter((p) => p === "/usr/local/bin")).toHaveLength(1);
    expect(parts.filter((p) => p === "/opt/homebrew/bin")).toHaveLength(1);
    // the pre-existing entries keep their relative order at the end
    const tail = parts.slice(-4);
    expect(tail).toEqual(["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/bin"]);
    expect(parts[0]).toBe(path.join(homedir(), ".local", "bin"));
  });

  it("handles an empty PATH", () => {
    process.env.PATH = "";
    const parts = ensureToolPaths().split(path.delimiter);
    expect(parts).not.toContain("");
    for (const d of FIXED) expect(parts).toContain(d);
  });
});
